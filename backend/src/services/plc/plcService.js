const net = require('net');
const EventEmitter = require('events');
const logger = require('../../config/logger');
const config = require('../../config');
const { getDb } = require('../../models/database');

/**
 * Siemens S7-1200 TCP Socket PLC Service
 * Protocol: ASCII TCP Socket
 * Target: 192.168.0.1:2000
 * Commands:
 *  - MOVE=xxxx
 *  - STOP=0000
 *  - ZERO=0000
 *
 * DEMO_MODE: if TCP connect fails, simulate the session so the workflow can be demoed.
 * REAL MODE (DEMO_MODE=false): never fake ONLINE. Offline commands fail.
 */
class SiemensPlcService extends EventEmitter {
  constructor() {
    super();
    this.devices = new Map();
    this.pollTimers = new Map();
    this.tagValues = new Map();
    this.reconnectTimers = new Map();
    this.isShuttingDown = false;
  }

  async startAll() {
    try {
      const db = getDb();
      let devices = db.prepare('SELECT * FROM plc_devices WHERE is_active = 1').all();

      if (devices.length === 0) {
        devices = [{
          id: 'plc_s7_1200_default',
          name: 'PLC-SIEMENS-S71200',
          ip_address: config.plc.defaultIp,
          port: config.plc.defaultPort,
          protocol: 's7-tcp',
          poll_interval: config.plc.pollIntervalMs,
          is_active: 1,
        }];
      }

      logger.info(`Starting Siemens S7-1200 TCP service for ${devices.length} device(s) [DEMO_MODE=${config.demoMode}]`);
      for (const device of devices) {
        await this.addDevice(device);
      }
    } catch (err) {
      logger.error('Error starting Siemens PLC service:', err);
    }
  }

  async addDevice(deviceConfig) {
    const ip = deviceConfig.ip_address || config.plc.defaultIp;
    const port = deviceConfig.port || config.plc.defaultPort;
    const formattedConfig = { ...deviceConfig, ip_address: ip, port, protocol: 's7-tcp' };

    const existing = this.devices.get(deviceConfig.id);
    if (existing?.socket) {
      try { existing.socket.destroy(); } catch { /* ignore */ }
    }

    this.devices.set(deviceConfig.id, {
      config: formattedConfig,
      socket: null,
      connected: false,
      isDemo: false,
      lastCommand: null,
      lastResponse: null,
    });

    logger.info(`Siemens S7-1200 added: ${formattedConfig.name} (${ip}:${port})`);
    await this.connect(deviceConfig.id);
  }

  async connect(deviceId) {
    if (this.isShuttingDown) return;

    const device = this.devices.get(deviceId);
    if (!device) return;

    const { ip_address, port, name, id } = device.config;
    this._updateDeviceStatus(id, 'connecting');

    const socket = new net.Socket();
    socket.setKeepAlive(true, 10000);
    // Idle timeout only while connecting. Cleared on successful connect.
    socket.setTimeout(config.plc.connectionTimeoutMs);

    socket.on('connect', () => {
      socket.setTimeout(0);
      logger.info(`Siemens PLC connected: ${name} (${ip_address}:${port})`);
      device.connected = true;
      device.isDemo = false;
      device.socket = socket;
      this._updateDeviceStatus(id, 'connected');
      this._logPlcEvent('CONNECT', `PLC Siemens ${name} (${ip_address}:${port}) connected`);
      this.emit('device:connected', {
        deviceId: id,
        name,
        ip: ip_address,
        port,
        isDemo: false,
        mode: 'REAL',
      });
    });

    socket.on('data', (data) => {
      const responseStr = data.toString('utf8').trim();
      if (!responseStr) return;
      logger.info(`Siemens PLC [${name}] RX: ${responseStr}`);
      this._handleSocketData(deviceId, responseStr);
    });

    socket.on('error', (err) => {
      logger.warn(`Siemens PLC socket error [${name}]: ${err.message}`);
      this._handleDisconnect(deviceId, `Socket error: ${err.message}`);
    });

    socket.on('timeout', () => {
      logger.warn(`Siemens PLC connection timeout [${name}] (${ip_address}:${port})`);
      socket.destroy();
    });

    socket.on('close', () => {
      if (device.socket === socket) {
        this._handleDisconnect(deviceId, 'Connection closed');
      }
    });

    try {
      socket.connect(port, ip_address);
      device.socket = socket;
    } catch (err) {
      logger.warn(`Failed to trigger socket connect [${name}]: ${err.message}`);
      this._handleDisconnect(deviceId, err.message);
    }
  }

  _handleDisconnect(deviceId, reason) {
    const device = this.devices.get(deviceId);
    if (!device) return;

    const wasDemo = device.isDemo;
    const wasConnectedReal = device.connected && !device.isDemo;

    if (device.socket) {
      const sock = device.socket;
      device.socket = null;
      try { sock.destroy(); } catch { /* ignore */ }
    }

    if (this.isShuttingDown) {
      device.connected = false;
      device.isDemo = false;
      this._updateDeviceStatus(deviceId, 'disconnected');
      return;
    }

    // Already in DEMO fallback — do not re-enter.
    if (wasDemo) return;

    if (config.demoMode) {
      logger.info(`[DEMO_MODE] PLC ${device.config.name} unreachable (${reason}). Simulating session — not a real ONLINE link.`);
      device.connected = true;
      device.isDemo = true;
      this._updateDeviceStatus(deviceId, 'connected');
      this._logPlcEvent('STATUS', `[DEMO] Simulated session for ${device.config.name}: ${reason}`);
      this.emit('device:connected', {
        deviceId,
        name: device.config.name,
        ip: device.config.ip_address,
        port: device.config.port,
        isDemo: true,
        mode: 'DEMO',
      });
      this._startDemoHeartbeat(deviceId);
      return;
    }

    // REAL MODE: never fake ONLINE
    device.connected = false;
    device.isDemo = false;
    this._updateDeviceStatus(deviceId, 'disconnected');
    this._stopDemoHeartbeat(deviceId);

    if (wasConnectedReal) {
      this._logPlcEvent('DISCONNECT', `Siemens PLC ${device.config.name} disconnected: ${reason}`);
      this.emit('device:disconnected', { deviceId, reason, mode: 'REAL' });
    } else {
      this._logPlcEvent('ERROR', `Siemens PLC ${device.config.name} offline: ${reason}`);
      this.emit('device:disconnected', { deviceId, reason, mode: 'REAL' });
    }

    if (!this.reconnectTimers.has(deviceId)) {
      const timer = setTimeout(() => {
        this.reconnectTimers.delete(deviceId);
        logger.info(`Reconnect Siemens PLC ${device.config.name} (${device.config.ip_address}:${device.config.port})...`);
        this.connect(deviceId);
      }, 5000);
      this.reconnectTimers.set(deviceId, timer);
    }
  }

  _handleSocketData(deviceId, responseStr) {
    const device = this.devices.get(deviceId);
    if (device) device.lastResponse = responseStr;
    this.emit('data:received', { deviceId, response: responseStr });
    this._logPlcEvent('STATUS', `RX: ${responseStr}`, null, responseStr);
    this.emit('plc:response', { deviceId, response: responseStr, timestamp: new Date().toISOString() });
  }

  formatMoveCommand(revs) {
    const n = Math.max(0, Math.min(9999, parseInt(revs, 10) || 0));
    return `MOVE=${String(n).padStart(4, '0')}`;
  }

  normalizeCommand(commandStr) {
    const raw = String(commandStr || '').trim().toUpperCase();
    if (raw.startsWith('MOVE=')) {
      return this.formatMoveCommand(raw.split('=')[1]);
    }
    if (raw === 'STOP' || raw === 'STOP=0000') return 'STOP=0000';
    if (raw === 'ZERO' || raw === 'HOME' || raw === 'ZERO=0000') return 'ZERO=0000';
    if (/^(MOVE=\d{4}|STOP=0000|ZERO=0000)$/.test(raw)) return raw;
    throw new Error(`Invalid Siemens TCP command: ${commandStr}. Expected MOVE=xxxx, STOP=0000, or ZERO=0000.`);
  }

  async sendCommand(deviceId, commandStr) {
    const trimmedCmd = this.normalizeCommand(commandStr);
    const device = this._resolveDevice(deviceId);
    if (!device) {
      throw new Error('No Siemens PLC device registered');
    }

    if (!device.connected) {
      this._logPlcEvent('ERROR', `Failed ${trimmedCmd}: PLC offline (${device.config.ip_address}:${device.config.port})`, trimmedCmd);
      throw new Error(`Siemens PLC (${device.config.ip_address}:${device.config.port}) is OFFLINE. Cannot send ${trimmedCmd}.`);
    }

    logger.info(`Siemens PLC TX [${device.config.name}]: ${trimmedCmd}`);

    // Only simulated when the session itself is a DEMO fallback (not when DEMO_MODE is on but TCP is actually up)
    if (device.isDemo) {
      const simulatedResponse = `ACK ${trimmedCmd}`;
      device.lastCommand = trimmedCmd;
      device.lastResponse = simulatedResponse;
      this._logPlcEvent('COMMAND', `[DEMO] TX: ${trimmedCmd} -> ${simulatedResponse}`, trimmedCmd, simulatedResponse);
      this._applyCommandedState(device.config.id, trimmedCmd);
      const result = {
        success: true,
        deviceId: device.config.id,
        command: trimmedCmd,
        response: simulatedResponse,
        mode: 'DEMO',
        timestamp: new Date().toISOString(),
      };
      this.emit('command:sent', result);
      return result;
    }

    return new Promise((resolve, reject) => {
      const socket = device.socket;
      if (!socket || socket.destroyed) {
        return reject(new Error(`Siemens PLC TCP socket disconnected (${device.config.ip_address}:${device.config.port})`));
      }

      const payload = `${trimmedCmd}\r\n`;
      socket.write(payload, 'utf8', (err) => {
        if (err) {
          logger.error(`Siemens PLC write failed: ${err.message}`);
          this._logPlcEvent('ERROR', `TX failed ${trimmedCmd}: ${err.message}`, trimmedCmd);
          return reject(new Error(`Socket write error: ${err.message}`));
        }

        device.lastCommand = trimmedCmd;
        const response = `SENT ${trimmedCmd}`;
        this._logPlcEvent('COMMAND', `TX: ${trimmedCmd}`, trimmedCmd, response);
        this._applyCommandedState(device.config.id, trimmedCmd);
        const result = {
          success: true,
          deviceId: device.config.id,
          command: trimmedCmd,
          response,
          mode: 'REAL',
          timestamp: new Date().toISOString(),
        };
        this.emit('command:sent', result);
        resolve(result);
      });
    });
  }

  _resolveDevice(deviceId) {
    if (deviceId && this.devices.has(deviceId)) return this.devices.get(deviceId);
    return Array.from(this.devices.values())[0] || null;
  }

  async sendMove(deviceId, revs) {
    return this.sendCommand(deviceId, this.formatMoveCommand(revs));
  }

  async sendStop(deviceId) {
    return this.sendCommand(deviceId, 'STOP=0000');
  }

  async sendZero(deviceId) {
    return this.sendCommand(deviceId, 'ZERO=0000');
  }

  /**
   * Track last-commanded state for UI. This is not a fake PLC read —
   * it records what the server actually sent (or simulated in DEMO).
   */
  _applyCommandedState(deviceId, command) {
    const db = getDb();
    const tags = db.prepare('SELECT * FROM plc_tags WHERE device_id = ?').all(deviceId);
    const ts = new Date().toISOString();

    for (const tag of tags) {
      let val = undefined;
      if (command.startsWith('MOVE=')) {
        if (tag.tag_name === 'MachineRunning') val = true;
        if (tag.tag_name === 'TargetRevs') val = parseInt(command.split('=')[1], 10) || 0;
        if (tag.tag_name === 'MotorSpeed') val = 600;
      } else if (command === 'STOP=0000') {
        if (tag.tag_name === 'MachineRunning') val = false;
        if (tag.tag_name === 'MotorSpeed') val = 0;
      } else if (command === 'ZERO=0000') {
        if (tag.tag_name === 'MachineRunning') val = false;
        if (tag.tag_name === 'MotorSpeed') val = 0;
        if (tag.tag_name === 'ProductionCount') val = 0;
      }

      if (val !== undefined) {
        this.tagValues.set(tag.id, { value: val, quality: 'good', timestamp: ts, source: 'command' });
        try {
          db.prepare('INSERT INTO plc_tag_values (tag_id, value, quality, timestamp) VALUES (?, ?, ?, ?)')
            .run(tag.id, String(val), 'good', ts);
        } catch { /* ignore log write errors */ }
      }
    }

    this.emit('tags:updated', { deviceId, tags: this.getTagValues(deviceId).map(t => ({
      tagId: t.id,
      tagName: t.tag_name,
      value: t.currentValue?.value,
      quality: t.currentValue?.quality || 'good',
      unit: t.unit,
      timestamp: ts,
    })) });
  }

  _startDemoHeartbeat(deviceId) {
    this._stopDemoHeartbeat(deviceId);
    const device = this.devices.get(deviceId);
    const interval = device?.config?.poll_interval || config.plc.pollIntervalMs;
    const timer = setInterval(() => this._emitDemoHeartbeat(deviceId), interval);
    this.pollTimers.set(deviceId, timer);
    this._emitDemoHeartbeat(deviceId);
  }

  _stopDemoHeartbeat(deviceId) {
    if (this.pollTimers.has(deviceId)) {
      clearInterval(this.pollTimers.get(deviceId));
      this.pollTimers.delete(deviceId);
    }
  }

  _emitDemoHeartbeat(deviceId) {
    const device = this.devices.get(deviceId);
    if (!device || !device.isDemo) return;

    try {
      const db = getDb();
      const tags = db.prepare('SELECT * FROM plc_tags WHERE device_id = ? AND is_monitored = 1').all(deviceId);
      if (tags.length === 0) return;

      const timestamp = new Date().toISOString();
      const tagData = tags.map((tag) => {
        const current = this.tagValues.get(tag.id);
        const val = current ? current.value : this._getDefaultTagValue(tag);
        this.tagValues.set(tag.id, { value: val, quality: 'good', timestamp, source: 'demo' });
        return {
          tagId: tag.id,
          tagName: tag.tag_name,
          value: val,
          quality: 'good',
          unit: tag.unit,
          timestamp,
        };
      });

      this.emit('tags:updated', { deviceId, tags: tagData });
    } catch (err) {
      logger.debug(`Demo heartbeat error [${deviceId}]: ${err.message}`);
    }
  }

  _getDefaultTagValue(tag) {
    if (tag.data_type === 'BOOL') return false;
    if (tag.data_type === 'INT' || tag.data_type === 'DINT') return 0;
    if (tag.data_type === 'REAL') return 0.0;
    return 0;
  }

  async writeTag(deviceId, tagId, value) {
    const device = this._resolveDevice(deviceId);
    if (!device || !device.connected) {
      throw new Error(`Siemens PLC device ${deviceId} is not connected`);
    }

    const db = getDb();
    const tag = db.prepare('SELECT * FROM plc_tags WHERE id = ? AND device_id = ?').get(tagId, device.config.id);
    if (!tag) throw new Error(`Tag ${tagId} not found`);

    if (tag.tag_name === 'TargetRevs') {
      return this.sendMove(device.config.id, value);
    }
    if (tag.tag_name === 'MachineRunning') {
      const on = value === true || value === 'true' || value === 1 || value === '1';
      if (on) {
        const revsTag = db.prepare("SELECT * FROM plc_tags WHERE device_id = ? AND tag_name = 'TargetRevs'").get(device.config.id);
        const current = revsTag ? this.tagValues.get(revsTag.id) : null;
        const revs = current?.value || 1000;
        return this.sendMove(device.config.id, revs);
      }
      return this.sendStop(device.config.id);
    }

    throw new Error('Siemens S7-1200 TCP Socket only supports MOVE=xxxx, STOP=0000, ZERO=0000');
  }

  getTagValues(deviceId) {
    const db = getDb();
    const tags = db.prepare('SELECT * FROM plc_tags WHERE device_id = ?').all(deviceId);
    return tags.map(tag => ({
      ...tag,
      currentValue: this.tagValues.get(tag.id) || { value: this._getDefaultTagValue(tag), quality: 'unknown' },
    }));
  }

  getDeviceStatus(deviceId) {
    const device = this.devices.get(deviceId);
    if (!device) return null;
    return {
      deviceId,
      connected: device.connected,
      isDemo: device.isDemo,
      mode: device.isDemo ? 'DEMO' : (device.connected ? 'REAL' : 'OFFLINE'),
      lastCommand: device.lastCommand,
      lastResponse: device.lastResponse,
      config: device.config,
    };
  }

  getAllStatuses() {
    return Array.from(this.devices.entries()).map(([id, device]) => ({
      deviceId: id,
      name: device.config.name,
      ip: device.config.ip_address,
      port: device.config.port,
      connected: device.connected,
      isDemo: device.isDemo,
      mode: device.isDemo ? 'DEMO' : (device.connected ? 'REAL' : 'OFFLINE'),
      lastCommand: device.lastCommand,
      protocol: 's7-tcp',
    }));
  }

  _updateDeviceStatus(deviceId, status) {
    try {
      const db = getDb();
      const now = new Date().toISOString();
      const lastConn = status === 'connected' ? now : null;
      db.prepare(`
        UPDATE plc_devices SET connection_status = ?, last_connected = COALESCE(?, last_connected), updated_at = ?
        WHERE id = ?
      `).run(status, lastConn, now, deviceId);
    } catch (err) {
      logger.debug(`Device status update error: ${err.message}`);
    }
  }

  _logPlcEvent(eventType, message, commandSent = null, response = null) {
    try {
      const db = getDb();
      db.prepare(`
        INSERT INTO plc_events (event_type, message, command_sent, response, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(eventType, message, commandSent, response, new Date().toISOString());
    } catch (err) {
      logger.debug(`Log PLC event error: ${err.message}`);
    }
  }

  async shutdown() {
    this.isShuttingDown = true;
    logger.info('Shutting down Siemens PLC service...');

    for (const timer of this.pollTimers.values()) clearInterval(timer);
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);

    for (const [id, device] of this.devices.entries()) {
      if (device.socket) {
        try { device.socket.destroy(); } catch { /* ignore */ }
      }
      this._updateDeviceStatus(id, 'disconnected');
    }

    this.devices.clear();
    this.pollTimers.clear();
    this.reconnectTimers.clear();
    logger.info('Siemens PLC service shut down complete');
  }
}

const plcService = new SiemensPlcService();
module.exports = plcService;
