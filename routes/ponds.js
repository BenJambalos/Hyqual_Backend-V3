const express = require('express');
const pool = require('../db');
const { requireAuth, requireFarm } = require('../middleware/auth');
const { progressFraction, PARAM_LABELS, PARAM_UNITS } = require('../utils/status');
const { PONDS_QUERY, getThresholds, evaluatePond, pondRowToJson } = require('../utils/pondState');

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

// How a pond looks (status, online/offline, which reading) is decided in
// utils/pondState.js, shared with the alarm endpoint and the device-move reply.

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
  const ev = evaluatePond(row, thresholds);
  const reading = ev.shownReading;

  const parameters = ['temperature', 'ph', 'dissolved_oxygen', 'salinity'].map((key) => {
    const t = thresholds[key] || {};
    const raw = reading ? (key === 'ph' ? reading.ph_level : reading[key]) : null;
    const value = raw === undefined ? null : raw;
    return {
      key,
      label: PARAM_LABELS[key],
      unit: PARAM_UNITS[key],
      value,
      min: t.min ?? null,
      max: t.max ?? null,
      status: ev.byParameter[key] || 'normal',
      progress: value !== null ? progressFraction(value, t.min, t.max) : 0,
    };
  });

  res.json({ ...base, parameters, deviceOnline: ev.online });
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

  // The ML service forecasts HOURLY averages, so the history shown next to
  // them is hourly too (last 24 hours). The chart plots points by position,
  // so mixing 5-minute readings with hourly forecasts would distort its
  // time axis. `column` comes from the fixed COLUMNS map above, never from
  // user input. A pond with under 3 hours of data falls back to its latest
  // raw readings, as before.
  const [hourly] = await pool.query(
    `SELECT AVG(${column}) AS value, DATE_FORMAT(recorded_at, '%Y-%m-%d %H:00:00') AS hour_bucket
     FROM water_quality_readings
     WHERE pond_id = ? AND recorded_at >= (NOW() - INTERVAL 24 HOUR) AND ${column} IS NOT NULL
     GROUP BY hour_bucket ORDER BY hour_bucket ASC`,
    [pondRows[0].pond_id]
  );
  let historical;
  if (hourly.length >= 3) {
    historical = hourly.map((r) => Math.round(Number(r.value) * 100) / 100);
  } else {
    const [hist] = await pool.query(
      `SELECT ${column} AS value, recorded_at FROM water_quality_readings
       WHERE pond_id = ? ORDER BY recorded_at DESC LIMIT 24`,
      [pondRows[0].pond_id]
    );
    historical = hist.reverse().map((r) => Number(r.value));
  }

  // Only the NEWEST forecast batch (rows sharing the latest created_at for
  // this pond + parameter) and only its future points. Older batches, and
  // the sample forecasts from seed_data.sql, stay in the table but are never
  // mixed into what the farmer sees.
  const [forecastRows] = await pool.query(
    `SELECT forecast_value, predicted_for, created_at FROM water_quality_forecasts
     WHERE pond_id = ? AND parameter = ? AND predicted_for > NOW()
       AND created_at = (SELECT MAX(created_at) FROM water_quality_forecasts WHERE pond_id = ? AND parameter = ?)
     ORDER BY predicted_for ASC`,
    [pondRows[0].pond_id, parameter, pondRows[0].pond_id, parameter]
  );

  res.json({
    parameter,
    historical,
    forecast: forecastRows.map((r) => Number(r.forecast_value)),
    predictedForTimestamps: forecastRows.map((r) => r.predicted_for),
    generatedAt: forecastRows.length ? forecastRows[0].created_at : null,
  });
});

module.exports = router;
