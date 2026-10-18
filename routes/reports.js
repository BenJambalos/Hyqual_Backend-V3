const express = require('express');
const pool = require('../db');
const { requireAuth, requireFarm } = require('../middleware/auth');
const { paramStatus } = require('../utils/status');

const router = express.Router();
router.use(requireAuth, requireFarm);

// Reports are per POND and read the readings that were taken in that pond
// (water_quality_readings.pond_id) - not "whatever the pond's current device
// recorded" - so moving a device never moves history with it. Also checks the
// pond is the caller's. Returns the pond id, or null.
async function ownedPondId(pondId, farmId) {
  const id = Number(pondId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const [rows] = await pool.query('SELECT pond_id FROM ponds WHERE pond_id = ? AND farm_id = ?', [id, farmId]);
  return rows[0]?.pond_id || null;
}

async function getThresholds(farmId) {
  const [rows] = await pool.query('SELECT parameter, min_value, max_value FROM parameter_thresholds WHERE farm_id = ?', [farmId]);
  const map = {};
  for (const r of rows) map[r.parameter] = { min: r.min_value, max: r.max_value };
  return map;
}

function rowStatus(row, thresholds) {
  const statuses = [
    paramStatus(row.temperature, thresholds.temperature?.min, thresholds.temperature?.max),
    paramStatus(row.ph_level, thresholds.ph?.min, thresholds.ph?.max),
    paramStatus(row.dissolved_oxygen, thresholds.dissolved_oxygen?.min, thresholds.dissolved_oxygen?.max),
    paramStatus(row.salinity, thresholds.salinity?.min, thresholds.salinity?.max),
  ];
  if (statuses.includes('critical')) return 'critical';
  if (statuses.includes('warning')) return 'warning';
  return 'normal';
}

// GET /api/reports/trend?pondId=1&hours=24
// Hourly-bucketed averages for the "Overall Monitoring Trends" chart.
// Anchored to the most recent reading for that pond (rather than a
// calendar boundary) so it's correct both in production (continuous
// data) and against a demo dataset that isn't updating in real time.
router.get('/reports/trend', async (req, res) => {
  const pondId = await ownedPondId(req.query.pondId, req.farmId);
  if (!pondId) return res.json({ labels: [], temperature: [], dissolvedOxygen: [], ph: [], salinity: [] });

  const hours = Number(req.query.hours) || 24;
  // hour_label uses MIN(recorded_at) (every row in a bucket shares the same
  // hour) so the query is valid under MySQL 8's default ONLY_FULL_GROUP_BY
  // mode, which Railway's MySQL enforces. The un-aggregated column used to
  // make this endpoint return a 500 there.
  const [rows] = await pool.query(
    `SELECT
        DATE_FORMAT(MIN(recorded_at), '%H:00') AS hour_label,
        MIN(recorded_at) AS bucket_start,
        ROUND(AVG(temperature), 2) AS avg_temp,
        ROUND(AVG(dissolved_oxygen), 2) AS avg_do,
        ROUND(AVG(ph_level), 2) AS avg_ph,
        ROUND(AVG(salinity), 2) AS avg_sal
     FROM water_quality_readings
     WHERE pond_id = ?
       AND recorded_at >= (SELECT MAX(recorded_at) FROM water_quality_readings WHERE pond_id = ?) - INTERVAL ? HOUR
     GROUP BY HOUR(recorded_at)
     ORDER BY bucket_start ASC`,
    [pondId, pondId, hours]
  );

  res.json({
    labels: rows.map((r) => r.hour_label),
    temperature: rows.map((r) => Number(r.avg_temp)),
    dissolvedOxygen: rows.map((r) => Number(r.avg_do)),
    ph: rows.map((r) => Number(r.avg_ph)),
    salinity: rows.map((r) => Number(r.avg_sal)),
  });
});

// GET /api/reports/reading-logs?pondId=1&status=Normal&limit=50
router.get('/reports/reading-logs', async (req, res) => {
  const pondId = await ownedPondId(req.query.pondId, req.farmId);
  if (!pondId) return res.json([]);
  const thresholds = await getThresholds(req.farmId);
  const limit = Math.min(Number(req.query.limit) || 50, 500);

  const [rows] = await pool.query(
    `SELECT temperature, ph_level, dissolved_oxygen, salinity, recorded_at
     FROM water_quality_readings WHERE pond_id = ? ORDER BY recorded_at DESC LIMIT ?`,
    [pondId, limit]
  );

  let logs = rows.map((r) => ({
    time: new Date(r.recorded_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }),
    temp: Number(r.temperature),
    do: Number(r.dissolved_oxygen),
    ph: Number(r.ph_level),
    salinity: Number(r.salinity),
    status: rowStatus(r, thresholds),
  }));

  if (req.query.status && req.query.status !== 'All') {
    logs = logs.filter((l) => l.status.toLowerCase() === String(req.query.status).toLowerCase());
  }
  res.json(logs);
});

// GET /api/reports/alert-logs?pondId=1&severity=Critical
router.get('/reports/alert-logs', async (req, res) => {
  const clauses = ['n.farm_id = ?'];
  const params = [req.farmId];
  if (req.query.pondId) { clauses.push('n.pond_id = ?'); params.push(req.query.pondId); }

  const [rows] = await pool.query(
    `SELECT n.*, p.pond_name FROM early_warning_notifications n
     LEFT JOIN ponds p ON p.pond_id = n.pond_id
     WHERE ${clauses.join(' AND ')} ORDER BY n.created_at DESC`,
    params
  );
  res.json(rows.map((r) => ({
    id: String(r.notification_id),
    title: r.title,
    pondName: r.pond_name,
    level: r.alert_level,
    message: r.alert_message,
    isResolved: !!r.is_resolved,
    createdAt: r.created_at,
  })));
});

// GET /api/reports/summary?pondId=1&period=weekly|monthly|daily
// This is the "use a query in reports to get the exact thing" endpoint:
// real AVG/MIN/MAX aggregation over water_quality_readings for the
// requested period, plus a compliance status per parameter and the
// incident log for that same window — matches the Report Detail / PDF
// preview screen field-for-field.
router.get('/reports/summary', async (req, res) => {
  const { pondId } = req.query;
  const period = req.query.period || 'weekly';
  const ownedPond = await ownedPondId(pondId, req.farmId);
  const thresholds = await getThresholds(req.farmId);

  const intervalSql = period === 'daily' ? 'INTERVAL 1 DAY' : period === 'monthly' ? 'INTERVAL 30 DAY' : 'INTERVAL 7 DAY';

  const [pondRows] = await pool.query('SELECT pond_name FROM ponds WHERE pond_id = ? AND farm_id = ?', [pondId, req.farmId]);
  if (!pondRows.length) return res.status(404).json({ error: 'Pond not found' });

  let aggregates = null;
  if (ownedPond) {
    const [rows] = await pool.query(
      `SELECT
          ROUND(AVG(temperature), 2) AS avg_temp, ROUND(MIN(temperature), 2) AS min_temp, ROUND(MAX(temperature), 2) AS max_temp,
          ROUND(AVG(ph_level), 2) AS avg_ph, ROUND(MIN(ph_level), 2) AS min_ph, ROUND(MAX(ph_level), 2) AS max_ph,
          ROUND(AVG(dissolved_oxygen), 2) AS avg_do, ROUND(MIN(dissolved_oxygen), 2) AS min_do, ROUND(MAX(dissolved_oxygen), 2) AS max_do,
          ROUND(AVG(salinity), 2) AS avg_sal, ROUND(MIN(salinity), 2) AS min_sal, ROUND(MAX(salinity), 2) AS max_sal,
          COUNT(*) AS reading_count, MIN(recorded_at) AS period_start, MAX(recorded_at) AS period_end
       FROM water_quality_readings
       WHERE pond_id = ?
         AND recorded_at >= (SELECT MAX(recorded_at) FROM water_quality_readings WHERE pond_id = ?) - ${intervalSql}`,
      [ownedPond, ownedPond]
    );
    aggregates = rows[0];
  }

  const [incidents] = await pool.query(
    `SELECT created_at, parameter, alert_message, alert_level FROM early_warning_notifications
     WHERE pond_id = ?
       AND created_at >= (SELECT COALESCE(MAX(recorded_at), NOW()) FROM water_quality_readings WHERE pond_id = ?) - ${intervalSql}
     ORDER BY created_at DESC`,
    [pondId, pondId]
  );

  function row(label, key, avgKey, minKey, maxKey, unit) {
    if (!aggregates || aggregates[avgKey] === null) return { parameter: label, avg: '—', min: '—', max: '—', status: 'offline' };
    const t = thresholds[key] || {};
    const status = paramStatus(Number(aggregates[avgKey]), t.min, t.max);
    const suffix = unit ? ` ${unit}` : '';
    return {
      parameter: label,
      avg: `${aggregates[avgKey]}${suffix}`,
      min: `${aggregates[minKey]}${suffix}`,
      max: `${aggregates[maxKey]}${suffix}`,
      status,
    };
  }

  res.json({
    pondName: pondRows[0].pond_name,
    period,
    periodStart: aggregates?.period_start || null,
    periodEnd: aggregates?.period_end || null,
    readingCount: aggregates?.reading_count || 0,
    parameters: [
      row('Dissolved Oxygen (DO)', 'dissolved_oxygen', 'avg_do', 'min_do', 'max_do', 'mg/L'),
      row('Water Temperature', 'temperature', 'avg_temp', 'min_temp', 'max_temp', '\u00b0C'),
      row('pH Level', 'ph', 'avg_ph', 'min_ph', 'max_ph', ''),
      row('Salinity', 'salinity', 'avg_sal', 'min_sal', 'max_sal', 'ppt'),
    ],
    incidents: incidents.map((i) => ({
      timestamp: i.created_at,
      parameter: i.parameter,
      message: i.alert_message,
      level: i.alert_level,
    })),
  });
});

// GET /api/reports/list?pondId=1  — the 3 report cards (Weekly/Monthly/Daily).
// Computed from the current date rather than stored, since they're just
// "the last 7/30/1 day(s) as of now" — nothing to persist.
router.get('/reports/list', async (req, res) => {
  const [pondRows] = await pool.query('SELECT pond_name FROM ponds WHERE pond_id = ? AND farm_id = ?', [req.query.pondId, req.farmId]);
  const pondName = pondRows[0]?.pond_name || '';
  const now = new Date();
  const fmt = (d) => d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const weekAgo = new Date(now.getTime() - 7 * 86400000);
  const monthAgo = new Date(now.getTime() - 30 * 86400000);

  res.json([
    { id: 'weekly', title: `Weekly Summary ${pondName}`, subtitle: `${fmt(weekAgo)} \u2013 ${fmt(now)}`, period: 'weekly' },
    { id: 'monthly', title: 'Monthly Summary', subtitle: fmt(monthAgo), period: 'monthly' },
    { id: 'daily', title: 'Daily Summary', subtitle: fmt(now), period: 'daily' },
  ]);
});

module.exports = router;
