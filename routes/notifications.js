const express = require('express');
const pool = require('../db');
const { requireAuth, requireFarm } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireFarm);

function levelToSeverity(level) {
  // App's 4 severities: normal/warning/critical/offline.
  // Schema's alert_level: low/medium/high/critical.
  if (level === 'critical') return 'critical';
  if (level === 'high' || level === 'medium') return 'warning';
  return 'normal'; // 'low' — e.g. "Water Quality Restored"
}

function dateGroupFor(createdAt) {
  const created = new Date(createdAt);
  const now = new Date();
  const isSameDay = (a, b) => a.toDateString() === b.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(created, now)) return 'TODAY';
  if (isSameDay(created, yesterday)) return 'YESTERDAY';
  return created.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }).toUpperCase();
}

function rowToJson(row) {
  const isOfflineAlert = row.title === 'Device Offline' || (!row.parameter && row.device_id && !row.is_resolved && row.alert_level === 'low');
  return {
    id: String(row.notification_id),
    severity: isOfflineAlert ? 'offline' : levelToSeverity(row.alert_level),
    title: row.title,
    pondName: row.pond_name || 'Farm-wide',
    description: row.alert_message,
    trend: row.is_resolved ? null : (row.parameter ? 'Deteriorating Trend' : null),
    dateGroup: dateGroupFor(row.created_at),
    time: new Date(row.created_at).toLocaleString('en-US', {
      month: '2-digit', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
    }),
    read: !!row.is_read,
    recommendedAction: row.recommended_action,
    thresholdText: null, // could be derived from parameter_thresholds + parameter if you want it live-computed
  };
}

const NOTIF_QUERY = `
  SELECT n.*, p.pond_name
  FROM early_warning_notifications n
  LEFT JOIN ponds p ON p.pond_id = n.pond_id
  WHERE n.farm_id = ?
`;

// GET /api/notifications?severity=Critical&pondId=1
router.get('/notifications', async (req, res) => {
  const clauses = ['n.farm_id = ?'];
  const params = [req.farmId];
  if (req.query.pondId) {
    clauses.push('n.pond_id = ?');
    params.push(req.query.pondId);
  }
  const [rows] = await pool.query(
    `SELECT n.*, p.pond_name FROM early_warning_notifications n
     LEFT JOIN ponds p ON p.pond_id = n.pond_id
     WHERE ${clauses.join(' AND ')} ORDER BY n.created_at DESC`,
    params
  );
  let list = rows.map(rowToJson);
  if (req.query.severity && req.query.severity !== 'All') {
    list = list.filter((n) => n.severity.toLowerCase() === String(req.query.severity).toLowerCase());
  }
  res.json(list);
});

// GET /api/notifications/:id
router.get('/notifications/:id', async (req, res) => {
  const [rows] = await pool.query(NOTIF_QUERY + ' AND n.notification_id = ?', [req.farmId, req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Notification not found' });
  res.json(rowToJson(rows[0]));
});

// PUT /api/notifications/:id/read  { read: true|false }
router.put('/notifications/:id/read', async (req, res) => {
  const read = req.body.read !== false;
  const [result] = await pool.query(
    'UPDATE early_warning_notifications SET is_read = ? WHERE notification_id = ? AND farm_id = ?',
    [read ? 1 : 0, req.params.id, req.farmId]
  );
  if (!result.affectedRows) return res.status(404).json({ error: 'Notification not found' });
  res.json({ message: 'Updated.' });
});

// PUT /api/notifications/mark-all-read
router.put('/notifications/mark-all-read', async (req, res) => {
  await pool.query('UPDATE early_warning_notifications SET is_read = 1 WHERE farm_id = ?', [req.farmId]);
  res.json({ message: 'All marked as read.' });
});

module.exports = router;
