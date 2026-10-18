const express = require('express');
const pool = require('../db');
const { requireAuth, requireFarm } = require('../middleware/auth');
const { computePondStatus, progressFraction, PARAM_LABELS, PARAM_UNITS } = require('../utils/status');
const { connectivitySql } = require('../utils/deviceHealth');

const router = express.Router();
router.use(requireAuth, requireFarm);

// The "Pond Size" field's placeholder invites free text like "0.5
// hectare", but ponds.volume is a strict DECIMAL(10,2) column (per the
// schema). Passing non-numeric text straight into that column throws
// under MySQL/MariaDB's default strict SQL mode, which is exactly what
// was surfacing as a generic "Internal server error" — most visibly
// during onboarding, right before the device-assignment step, making it
// look like assignment itself was broken.
//
// Fix: extract the leading number from whatever was typed ("0.5
// hectare" -> 0.5, "1.2 ha" -> 1.2, "" or "abc" -> null) instead of
// crashing on it.
function parseDecimalOrNull(value) {
  if (value === undefined || value === null) return null;
  const str = String(value).trim();
  if (!str) return null;
  const match = str.match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : null;
}

async function getThresholds(farmId) {
  const [rows] = await pool.query('SELECT parameter, min_value, max_value FROM parameter_thresholds WHERE farm_id = ?', [farmId]);
  const map = {};
  for (const r of rows) map[r.parameter] = { min: r.min_value, max: r.max_value };
  return map;
}

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

function pondRowToJson(row, thresholds) {
  const reading = row.temperature !== null ? {
    temperature: row.temperature, ph_level: row.ph_level,
    dissolved_oxygen: row.dissolved_oxygen, salinity: row.salinity,
  } : null;
  const online = row.connectivity_status !== 'offline';
  const { overall } = computePondStatus(reading, thresholds, online);
  return {
    id: String(row.pond_id),
    name: row.pond_name,
    size: row.volume !== null ? String(row.volume) : '',
    status: overall,
    ph: reading?.ph_level ?? 0,
    dissolvedOxygen: reading?.dissolved_oxygen ?? 0,
    temperature: reading?.temperature ?? 0,
    salinity: reading?.salinity ?? 0,
    updatedAgo: timeAgo(row.recorded_at),
    assignedDeviceId: row.device_id ? String(row.device_id) : null,
  };
}

// "Latest reading" is the latest reading TAKEN IN THIS POND (wr.pond_id),
// not the latest reading of whatever device happens to be assigned now.
// So after a device is moved, the old pond keeps showing its own last
// reading (marked offline, with its age) and the new pond never shows
// numbers measured somewhere else. Connectivity comes from the device that
// is assigned to the pond right now; a pond with no device is offline.
const PONDS_QUERY = `
  SELECT p.pond_id, p.pond_name, p.volume, md.device_id,
    wr.temperature, wr.ph_level, wr.dissolved_oxygen, wr.salinity, wr.recorded_at,
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

// GET /api/ponds
router.get('/ponds', async (req, res) => {
  const thresholds = await getThresholds(req.farmId);
  const [rows] = await pool.query(PONDS_QUERY + ' ORDER BY p.pond_id', [req.farmId]);
  res.json(rows.map((r) => pondRowToJson(r, thresholds)));
});

// POST /api/ponds  { name, size }
router.post('/ponds', async (req, res) => {
  const { name, size } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const volume = parseDecimalOrNull(size);
  const [result] = await pool.query(
    'INSERT INTO ponds (farm_id, pond_name, volume) VALUES (?, ?, ?)',
    [req.farmId, name, volume]
  );
  res.status(201).json({ id: String(result.insertId), name, size: volume !== null ? String(volume) : '' });
});

// PUT /api/ponds/:id  { name, size }
router.put('/ponds/:id', async (req, res) => {
  const { name, size } = req.body;
  const volume = size === undefined ? null : parseDecimalOrNull(size);
  const [result] = await pool.query(
    'UPDATE ponds SET pond_name = COALESCE(?, pond_name), volume = COALESCE(?, volume) WHERE pond_id = ? AND farm_id = ?',
    [name, volume, req.params.id, req.farmId]
  );
  if (!result.affectedRows) return res.status(404).json({ error: 'Pond not found' });
  res.json({ message: 'Pond updated.' });
});

// DELETE /api/ponds/:id
router.delete('/ponds/:id', async (req, res) => {
  const [result] = await pool.query('DELETE FROM ponds WHERE pond_id = ? AND farm_id = ?', [req.params.id, req.farmId]);
  if (!result.affectedRows) return res.status(404).json({ error: 'Pond not found' });
  res.json({ message: 'Pond removed.' });
});

// GET /api/ponds/:id  — full detail for the Pond Detail "Current" tab
router.get('/ponds/:id', async (req, res) => {
  const thresholds = await getThresholds(req.farmId);
  const [rows] = await pool.query(PONDS_QUERY + ' AND p.pond_id = ?', [req.farmId, req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Pond not found' });
  const row = rows[0];
  const base = pondRowToJson(row, thresholds);

  const reading = row.temperature !== null ? {
    temperature: row.temperature, ph_level: row.ph_level,
    dissolved_oxygen: row.dissolved_oxygen, salinity: row.salinity,
  } : null;
  const online = row.connectivity_status !== 'offline';
  const { byParameter } = computePondStatus(reading, thresholds, online);

  const parameters = ['temperature', 'ph', 'dissolved_oxygen', 'salinity'].map((key) => {
    const t = thresholds[key] || {};
    const value = reading ? (key === 'ph' ? reading.ph_level : reading[key]) : null;
    return {
      key,
      label: PARAM_LABELS[key],
      unit: PARAM_UNITS[key],
      value,
      min: t.min ?? null,
      max: t.max ?? null,
      status: byParameter[key] || 'normal',
      progress: value !== null ? progressFraction(value, t.min, t.max) : 0,
    };
  });

  res.json({ ...base, parameters, deviceOnline: online });
});

// GET /api/ponds/:id/forecast?parameter=dissolved_oxygen
router.get('/ponds/:id/forecast', async (req, res) => {
  const parameter = req.query.parameter || 'dissolved_oxygen';
  const COLUMNS = { temperature: 'temperature', ph: 'ph_level', dissolved_oxygen: 'dissolved_oxygen', salinity: 'salinity' };
  const column = COLUMNS[parameter];
  if (!column) return res.status(400).json({ error: 'Unknown parameter' });

  // History comes from the pond itself (readings carry their pond_id), so it
  // is the same series whichever device produced it. The pond must be the
  // caller's, otherwise this would leak another farm's readings.
  const [pondRows] = await pool.query('SELECT pond_id FROM ponds WHERE pond_id = ? AND farm_id = ?', [req.params.id, req.farmId]);
  if (!pondRows.length) return res.status(404).json({ error: 'Pond not found' });

  const [hist] = await pool.query(
    `SELECT ${column} AS value, recorded_at FROM water_quality_readings
     WHERE pond_id = ? ORDER BY recorded_at DESC LIMIT 24`,
    [pondRows[0].pond_id]
  );
  const historical = hist.reverse().map((r) => Number(r.value));

  const [forecastRows] = await pool.query(
    `SELECT forecast_value, predicted_for FROM water_quality_forecasts
     WHERE pond_id = ? AND parameter = ? AND predicted_for > NOW() ORDER BY predicted_for ASC`,
    [pondRows[0].pond_id, parameter]
  );

  res.json({
    parameter,
    historical,
    forecast: forecastRows.map((r) => Number(r.forecast_value)),
    predictedForTimestamps: forecastRows.map((r) => r.predicted_for),
  });
});

module.exports = router;
