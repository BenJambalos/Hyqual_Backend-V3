// One place that decides what a POND looks like right now (status, online /
// offline, which reading to show). The Ponds list, the pond detail screen,
// the "device moved" reply and the alarm endpoint ALL use this, so they can
// never disagree with each other.
//
// Rules (this is what makes a device move show up instantly):
//   * A pond is judged by the device assigned to it RIGHT NOW. No device, or
//     a device that has gone silent -> OFFLINE. So the pond a device LEAVES
//     is offline the moment the move is saved.
//   * A pond whose (online) device was JUST assigned has no reading of its own
//     yet. It is shown as online ("normal", "waiting for first reading")
//     instead of offline, until the first reading taken after the move
//     arrives. If none arrives within FIRST_READING_GRACE_SECONDS the device
//     is online but not delivering data, and the pond is OFFLINE again.
//   * Only readings taken since the device entered the pond count as the
//     pond's current reading (monitoring_devices.assigned_at). So moving a
//     device back into a pond it was in last week does not resurrect that
//     week-old reading (and cannot trigger an alarm from it).
const pool = require('../db');
const { computePondStatus, PARAM_LABELS, PARAM_UNITS } = require('./status');
const { connectivitySql } = require('./deviceHealth');

// The firmware sends a reading every 5 minutes (and immediately after it
// learns of a pond change). 10 minutes = two missed uploads.
const FIRST_READING_GRACE_SECONDS = Math.max(60, parseInt(process.env.POND_FIRST_READING_GRACE_SECONDS, 10) || 600);

// The alarm only rings for FRESH data. A critical reading older than this
// (default 20 minutes = four missed 5-minute uploads) is not "the water is
// critical right now"; it is a sensor that stopped delivering, which must not
// keep an alarm blaring on old numbers (or ring the moment someone logs in to
// a database full of old demo data). The pond card still shows its last status.
const ALARM_MAX_READING_AGE_SECONDS = Math.max(60, parseInt(process.env.ALARM_MAX_READING_AGE_SECONDS, 10) || 1200);

function timeAgo(date) {
  if (!date) return 'never';
  const diffMs = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

async function getThresholds(farmId) {
  const [rows] = await pool.query('SELECT parameter, min_value, max_value FROM parameter_thresholds WHERE farm_id = ?', [farmId]);
  const map = {};
  for (const r of rows) map[r.parameter] = { min: r.min_value, max: r.max_value };
  return map;
}

// "Latest reading" is the latest reading TAKEN IN THIS POND (wr.pond_id), not
// the latest reading of whatever device is assigned now, so a moved device
// never drags numbers from one pond into another. Connectivity comes from the
// device assigned to the pond now (at most one: UNIQUE(monitoring_devices.pond_id)).
const PONDS_QUERY = `
  SELECT p.pond_id, p.pond_name, p.volume, md.device_id, md.device_name, md.assigned_at,
    TIMESTAMPDIFF(SECOND, md.assigned_at, NOW()) AS assigned_age_s,
    wr.reading_id, wr.temperature, wr.ph_level, wr.dissolved_oxygen, wr.salinity, wr.recorded_at,
    TIMESTAMPDIFF(SECOND, wr.recorded_at, NOW()) AS reading_age_s,
    (wr.reading_id IS NOT NULL AND (md.assigned_at IS NULL OR wr.recorded_at >= md.assigned_at)) AS reading_is_current,
    ${connectivitySql('ds')} AS connectivity_status
  FROM ponds p
  LEFT JOIN monitoring_devices md ON md.pond_id = p.pond_id
  LEFT JOIN water_quality_readings wr ON wr.reading_id = (
    SELECT wr2.reading_id FROM water_quality_readings wr2
    WHERE wr2.pond_id = p.pond_id ORDER BY wr2.recorded_at DESC, wr2.reading_id DESC LIMIT 1
  )
  LEFT JOIN device_status ds ON ds.device_id = md.device_id
  WHERE p.farm_id = ?
`;

// row = one row of PONDS_QUERY.
function evaluatePond(row, thresholds) {
  const hasDevice = row.device_id !== null && row.device_id !== undefined;
  const online = hasDevice && row.connectivity_status !== 'offline';
  const hasReading = row.reading_id !== null && row.reading_id !== undefined;
  const lastReading = hasReading ? {
    temperature: row.temperature, ph_level: row.ph_level,
    dissolved_oxygen: row.dissolved_oxygen, salinity: row.salinity,
  } : null;

  // No device / silent device: OFFLINE. Keep showing the pond's own last reading.
  if (!online) {
    return { hasDevice, online: false, awaitingReading: false, currentReading: null, shownReading: lastReading, status: 'offline', byParameter: {} };
  }

  // Online and the pond has a reading taken since the device arrived: judge it.
  if (hasReading && Number(row.reading_is_current) === 1) {
    const { overall, byParameter } = computePondStatus(lastReading, thresholds, true);
    return { hasDevice, online: true, awaitingReading: false, currentReading: lastReading, shownReading: lastReading, status: overall, byParameter };
  }

  // Online, but no reading from the new assignment yet.
  const age = row.assigned_age_s === null || row.assigned_age_s === undefined ? null : Number(row.assigned_age_s);
  if (age !== null && age <= FIRST_READING_GRACE_SECONDS) {
    return { hasDevice, online: true, awaitingReading: true, currentReading: null, shownReading: null, status: 'normal', byParameter: {} };
  }
  // Online but delivering no data (or a legacy row with no reading at all).
  return { hasDevice, online: true, awaitingReading: false, currentReading: null, shownReading: lastReading, status: 'offline', byParameter: {} };
}

function pondRowToJson(row, thresholds) {
  const ev = evaluatePond(row, thresholds);
  const shown = ev.shownReading;
  return {
    id: String(row.pond_id),
    name: row.pond_name,
    size: row.volume !== null ? String(row.volume) : '',
    status: ev.status,
    ph: shown?.ph_level ?? 0,
    dissolvedOxygen: shown?.dissolved_oxygen ?? 0,
    temperature: shown?.temperature ?? 0,
    salinity: shown?.salinity ?? 0,
    updatedAgo: ev.awaitingReading ? 'waiting for first reading' : timeAgo(row.recorded_at),
    assignedDeviceId: row.device_id ? String(row.device_id) : null,
    awaitingReading: ev.awaitingReading,
  };
}

// Status of ONE pond (used by the "device moved" reply).
async function pondSnapshot(farmId, pondId) {
  if (pondId === null || pondId === undefined) return null;
  const thresholds = await getThresholds(farmId);
  const [rows] = await pool.query(PONDS_QUERY + ' AND p.pond_id = ?', [farmId, pondId]);
  if (!rows.length) return null;
  const j = pondRowToJson(rows[0], thresholds);
  return { id: j.id, name: j.name, status: j.status, awaitingReading: j.awaitingReading, assignedDeviceId: j.assignedDeviceId };
}

const PARAM_KEYS = ['temperature', 'ph', 'dissolved_oxygen', 'salinity'];

function readingValue(reading, key) {
  if (!reading) return null;
  const v = key === 'ph' ? reading.ph_level : reading[key];
  return v === null || v === undefined ? null : Number(v);
}

// Every parameter that is CRITICAL right now, in ponds whose device is online
// and has delivered a FRESH reading since it was assigned. This is what sounds
// the alarm in the app. Warnings do not ring; offline / waiting / stale ponds
// do not ring.
function criticalAlarms(row, thresholds) {
  const ev = evaluatePond(row, thresholds);
  if (!ev.online || ev.awaitingReading || !ev.currentReading) return [];
  if (row.reading_age_s === null || row.reading_age_s === undefined || Number(row.reading_age_s) > ALARM_MAX_READING_AGE_SECONDS) return [];
  const out = [];
  for (const key of PARAM_KEYS) {
    if (ev.byParameter[key] !== 'critical') continue;
    const t = thresholds[key] || {};
    const value = readingValue(ev.currentReading, key);
    if (value === null) continue;
    const min = t.min !== null && t.min !== undefined ? Number(t.min) : null;
    const max = t.max !== null && t.max !== undefined ? Number(t.max) : null;
    const direction = min !== null && value < min ? 'low' : 'high';
    const unit = PARAM_UNITS[key];
    const safe = direction === 'low' ? `\u2265 ${min} ${unit}` : `\u2264 ${max} ${unit}`;
    out.push({
      key: `${row.pond_id}:${key}`,
      pondId: String(row.pond_id),
      pondName: row.pond_name,
      deviceName: row.device_name || null,
      parameter: key,
      label: PARAM_LABELS[key],
      unit,
      value,
      min,
      max,
      direction,
      message: `${PARAM_LABELS[key]} is critically ${direction}: ${value} ${unit} (safe ${safe})`,
      recordedAt: row.recorded_at,
    });
  }
  return out;
}

module.exports = {
  FIRST_READING_GRACE_SECONDS,
  ALARM_MAX_READING_AGE_SECONDS,
  PONDS_QUERY,
  getThresholds,
  timeAgo,
  evaluatePond,
  pondRowToJson,
  pondSnapshot,
  criticalAlarms,
  PARAM_KEYS,
};
