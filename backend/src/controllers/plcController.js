const { getDb } = require('../models/database');
const plcService = require('../services/plc/plcService');
const logger = require('../config/logger');
const { createAuditLog } = require('../middleware/auditMiddleware');

/**
 * GET /api/plc/devices
 */
function getDevices(req, res) {
  const db = getDb();
  const devices = db.prepare(`
    SELECT d.*,
      (SELECT COUNT(*) FROM plc_tags WHERE device_id = d.id) as tag_count,
      (SELECT COUNT(*) FROM plc_alarms WHERE device_id = d.id AND resolved_at IS NULL AND is_acknowledged = 0) as active_alarms
    FROM plc_devices d
    ORDER BY d.created_at ASC
  `).all();

  // Merge with live connection status
  const statuses = plcService.getAllStatuses();
  const statusMap = new Map(statuses.map(s => [s.deviceId, s]));

  const result = devices.map(d => ({
    ...d,
    liveStatus: statusMap.get(d.id),
  }));

  res.json({ success: true, data: result });
}

/**
 * POST /api/plc/devices
 */
async function createDevice(req, res) {
  try {
    const { name, description, ip_address, port, slot, rack, poll_interval } = req.body;

    if (!name || !ip_address) {
      return res.status(400).json({ success: false, error: 'Name and IP address required' });
    }

    const db = getDb();
    const id = require('crypto').randomBytes(16).toString('hex');

    db.prepare(`
      INSERT INTO plc_devices (id, name, description, ip_address, port, protocol, slot, rack, poll_interval)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, description || null, ip_address,
      port || 2000, 's7-tcp',
      slot || 0, rack || 0, poll_interval || 1000);

    const device = db.prepare('SELECT * FROM plc_devices WHERE id = ?').get(id);

    // Start connection to new device
    await plcService.addDevice(device);

    createAuditLog({ ...req.user, action: 'CREATE_PLC_DEVICE', resource: 'plc_devices', resourceId: id, req });
    logger.info(`PLC device created: ${name} by ${req.user.username}`);

    res.status(201).json({ success: true, data: device });
  } catch (err) {
    logger.error('Create device error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * PLC command endpoints use JOB / START / STOP / HOME / RESET only.
 */
async function sendCommand(req, res) {
  try {
    const { deviceId, command } = req.body;
    if (!command) {
      return res.status(400).json({ success: false, error: 'command is required (JOB=PPPP,RRRR,QQQQ | START=0000 | STOP=0000 | HOME=0000 | RESET=0000)' });
    }
    const result = await plcService.sendCommand(deviceId, command);
    createAuditLog({
      userId: req.user.id,
      username: req.user.username,
      action: 'PLC_COMMAND',
      resource: 'plc',
      details: { deviceId, command: result.command },
      req,
    });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
}

async function sendJob(req, res) {
  try {
    const { deviceId, productId, recipeId, targetQty } = req.body || {};
    const result = await plcService.sendJob(deviceId, productId, recipeId, targetQty);
    createAuditLog({ userId: req.user.id, username: req.user.username, action: 'PLC_JOB', details: { productId, recipeId, targetQty }, req });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
}

async function sendStart(req, res) {
  try {
    const { deviceId } = req.body || {};
    const result = await plcService.sendStart(deviceId);
    createAuditLog({ userId: req.user.id, username: req.user.username, action: 'PLC_START', req });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
}

async function sendStop(req, res) {
  try {
    const { deviceId } = req.body || {};
    const result = await plcService.sendStop(deviceId);
    createAuditLog({ userId: req.user.id, username: req.user.username, action: 'PLC_STOP', req });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
}

/**
 * POST /api/plc/devices/:id/home
 * Machine-level axis homing/reference command; independent of production jobs.
 */
async function sendHome(req, res) {
  const deviceId = req.params.id;
  try {
    const result = await plcService.sendHome(deviceId);
    const commandResult = result.mode === 'REAL' ? 'acknowledged' : 'demo';
    logger.info(`PLC HOME command result: deviceId=${deviceId} command=${result.command} mode=${result.mode} result=${commandResult}`);
    createAuditLog({
      userId: req.user.id,
      username: req.user.username,
      action: 'PLC_HOME',
      resource: 'plc_devices',
      resourceId: deviceId,
      details: { command: result.command, mode: result.mode, result: commandResult },
      req,
    });
    res.json({ success: true, data: { ...result, result: commandResult } });
  } catch (err) {
    logger.error(`PLC HOME command result: deviceId=${deviceId} command=HOME=0000 mode=${plcService.getDeviceStatus(deviceId)?.mode || 'OFFLINE'} result=error error=${err.message}`);
    res.status(400).json({ success: false, error: err.message });
  }
}

async function sendReset(req, res) {
  try {
    const { deviceId } = req.body || {};
    const result = await plcService.sendReset(deviceId);
    createAuditLog({ userId: req.user.id, username: req.user.username, action: 'PLC_RESET', req });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
}

/**
 * GET /api/plc/events
 */
function getPlcEvents(req, res) {
  const db = getDb();
  const { eventType, limit = 100, offset = 0 } = req.query;
  let query = 'SELECT * FROM plc_events WHERE 1=1';
  const params = [];
  if (eventType) { query += ' AND event_type = ?'; params.push(eventType); }
  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), parseInt(offset));
  const events = db.prepare(query).all(...params);
  res.json({ success: true, data: events });
}

/**
 * GET /api/plc/devices/:id/tags
 */
function getDeviceTags(req, res) {
  const { id } = req.params;
  const db = getDb();

  const device = db.prepare('SELECT * FROM plc_devices WHERE id = ?').get(id);
  if (!device) {
    return res.status(404).json({ success: false, error: 'Device not found' });
  }

  const tags = plcService.getTagValues(id);
  res.json({ success: true, data: tags });
}

/**
 * POST /api/plc/tags/write
 */
async function writeTag(req, res) {
  try {
    const { deviceId, tagId, value } = req.body;

    if (!deviceId || !tagId || value === undefined) {
      return res.status(400).json({ success: false, error: 'deviceId, tagId, and value required' });
    }

    const result = await plcService.writeTag(deviceId, tagId, value);

    createAuditLog({
      userId: req.user.id,
      username: req.user.username,
      action: 'WRITE_PLC_TAG',
      resource: 'plc_tags',
      resourceId: tagId,
      details: { deviceId, value },
      req,
    });

    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
}

/**
 * GET /api/plc/logs
 */
function getLogs(req, res) {
  const db = getDb();
  const { tagId, deviceId, limit = 100, offset = 0, from, to } = req.query;

  let query = `
    SELECT tv.*, t.tag_name, t.unit, t.data_type, d.name as device_name
    FROM plc_tag_values tv
    JOIN plc_tags t ON tv.tag_id = t.id
    JOIN plc_devices d ON t.device_id = d.id
    WHERE 1=1
  `;
  const params = [];

  if (tagId) { query += ' AND tv.tag_id = ?'; params.push(tagId); }
  if (deviceId) { query += ' AND t.device_id = ?'; params.push(deviceId); }
  if (from) { query += ' AND tv.timestamp >= ?'; params.push(from); }
  if (to) { query += ' AND tv.timestamp <= ?'; params.push(to); }

  query += ' ORDER BY tv.timestamp DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), parseInt(offset));

  const logs = db.prepare(query).all(...params);
  res.json({ success: true, data: logs });
}

/**
 * GET /api/plc/alarms
 */
function getAlarms(req, res) {
  const db = getDb();
  const { deviceId, unacknowledged, limit = 50 } = req.query;

  let query = `
    SELECT a.*, d.name as device_name, t.tag_name, u.username as ack_by
    FROM plc_alarms a
    JOIN plc_devices d ON a.device_id = d.id
    LEFT JOIN plc_tags t ON a.tag_id = t.id
    LEFT JOIN users u ON a.acknowledged_by = u.id
    WHERE 1=1
  `;
  const params = [];

  if (deviceId) { query += ' AND a.device_id = ?'; params.push(deviceId); }
  if (unacknowledged === 'true') { query += ' AND a.is_acknowledged = 0'; }

  query += ` ORDER BY a.triggered_at DESC LIMIT ${parseInt(limit)}`;

  const alarms = db.prepare(query).all(...params);
  res.json({ success: true, data: alarms });
}

/**
 * POST /api/plc/alarms/:id/acknowledge
 */
function acknowledgeAlarm(req, res) {
  const { id } = req.params;
  const db = getDb();

  const alarm = db.prepare('SELECT * FROM plc_alarms WHERE id = ?').get(id);
  if (!alarm) {
    return res.status(404).json({ success: false, error: 'Alarm not found' });
  }

  db.prepare(`
    UPDATE plc_alarms SET is_acknowledged = 1, acknowledged_by = ?, acknowledged_at = ? WHERE id = ?
  `).run(req.user.id, new Date().toISOString(), id);

  createAuditLog({ userId: req.user.id, username: req.user.username, action: 'ACK_ALARM', resource: 'plc_alarms', resourceId: id, req });
  res.json({ success: true, message: 'Alarm acknowledged' });
}

/**
 * GET /api/plc/dashboard - Summary stats
 */
function getDashboard(req, res) {
  const db = getDb();

  const stats = {
    devices: {
      total: db.prepare('SELECT COUNT(*) as c FROM plc_devices WHERE is_active = 1').get().c,
      connected: plcService.getAllStatuses().filter(s => s.connected).length,
    },
    tags: {
      total: db.prepare('SELECT COUNT(*) as c FROM plc_tags WHERE is_monitored = 1').get().c,
    },
    alarms: {
      active: db.prepare('SELECT COUNT(*) as c FROM plc_alarms WHERE resolved_at IS NULL').get().c,
      unacknowledged: db.prepare('SELECT COUNT(*) as c FROM plc_alarms WHERE is_acknowledged = 0 AND resolved_at IS NULL').get().c,
    },
    recentLogs: db.prepare(`
      SELECT tv.*, t.tag_name, d.name as device_name
      FROM plc_tag_values tv
      JOIN plc_tags t ON tv.tag_id = t.id
      JOIN plc_devices d ON t.device_id = d.id
      ORDER BY tv.timestamp DESC LIMIT 20
    `).all(),
  };

  res.json({ success: true, data: stats });
}

module.exports = {
  getDevices,
  createDevice,
  getDeviceTags,
  writeTag,
  getLogs,
  getAlarms,
  acknowledgeAlarm,
  getDashboard,
  sendCommand,
  sendJob,
  sendStart,
  sendStop,
  sendHome,
  sendReset,
  getPlcEvents,
};
