const net = require('net');
const EventEmitter = require('events');
const logger = require('../../config/logger');
const config = require('../../config');
const { getDb } = require('../../models/database');

const STATUS_REQUEST = 'STATUS=0000';
const STATUS_FRAME_LENGTH = Buffer.byteLength('STAT=1,1,0001,0001,0001,1,0,0,0000,1,0,0,0,0,00', 'ascii');
const ACK_FRAME_LENGTH = Buffer.byteLength('ACK=0001', 'ascii');
const COMMAND_ACK = {
  JOB: 'ACK=0001', START: 'ACK=0002', STOP: 'ACK=0003', RESET: 'ACK=0004', HOME: 'ACK=0005',
};

/**
 * Siemens S7-1200 TCP Socket PLC Service
 * Protocol: ASCII TCP Socket
 * Target: 192.168.0.1:2000
 * Commands: JOB=PPPP,RRRR,QQQQ / START=0000 / STOP=0000 / HOME=0000 / RESET=0000
 * Telemetry poll: STATUS=0000 -> STAT=S,J,PPPP,RRRR,QQQQ,R,U,F,EEEE,A,M,H,P,O,TT
 *
 * DEMO_MODE: if TCP connect fails, simulate the session so the workflow can be demoed.
 * REAL MODE (DEMO_MODE=false): never fake ONLINE. Offline commands fail.
 */
class SiemensPlcService extends EventEmitter {
  constructor() {
    super();
    this.devices = new Map();
    this.pollTimers = new Map();
    this.statusPollTimers = new Map();
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
      lastTelemetryAt: null,
      lastTelemetry: null,
      receiveBuffer: '',
      activeTransaction: null,
      machineQueue: [],
      statusPollPending: false,
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
      this._startStatusPolling(deviceId);
    });

    socket.on('data', (data) => {
      this._handleSocketData(deviceId, data.toString('ascii'));
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
    this._stopStatusPolling(deviceId);
    this._cancelTransactions(device, new Error(`PLC disconnected: ${reason}`));

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
    if (!device) return;

    device.receiveBuffer += String(responseStr || '');
    while (device.receiveBuffer.length > 0) {
      const statStart = device.receiveBuffer.indexOf('STAT=');
      const ackStart = device.receiveBuffer.indexOf('ACK=');
      const starts = [statStart, ackStart].filter(index => index >= 0);
      const frameStart = starts.length ? Math.min(...starts) : -1;
      if (frameStart < 0) {
        let retainedLength = 0;
        for (const prefix of ['STAT=', 'ACK=']) {
          for (let length = 1; length < prefix.length; length += 1) {
            if (device.receiveBuffer.endsWith(prefix.slice(0, length))) retainedLength = Math.max(retainedLength, length);
          }
        }
        const opaque = device.receiveBuffer.slice(0, device.receiveBuffer.length - retainedLength).trim();
        device.receiveBuffer = retainedLength ? device.receiveBuffer.slice(-retainedLength) : '';
        if (opaque) this._emitOpaqueResponse(deviceId, opaque);
        return;
      }
      if (frameStart > 0) {
        const opaque = device.receiveBuffer.slice(0, frameStart).trim();
        device.receiveBuffer = device.receiveBuffer.slice(frameStart);
        if (opaque) this._emitOpaqueResponse(deviceId, opaque);
      }

      if (device.receiveBuffer.startsWith('ACK=')) {
        if (device.receiveBuffer.length < ACK_FRAME_LENGTH) return;
        const frame = device.receiveBuffer.slice(0, ACK_FRAME_LENGTH);
        if (!/^ACK=000[1-5]$/.test(frame)) {
          logger.warn(`Rejected PLC ACK frame [${device.config.name}]: ${frame}`);
          this._logPlcEvent('ERROR', 'Rejected ACK frame', null, frame);
          device.receiveBuffer = device.receiveBuffer.slice(1);
          continue;
        }
        device.receiveBuffer = device.receiveBuffer.slice(ACK_FRAME_LENGTH);
        this._emitProtocolResponse(deviceId, frame);
        this._resolveAckTransaction(deviceId, frame);
        continue;
      }

      if (device.receiveBuffer.length < STATUS_FRAME_LENGTH) return;
      const frame = device.receiveBuffer.slice(0, STATUS_FRAME_LENGTH);
      try {
        const telemetry = this.parseStatusFrame(frame);
        device.receiveBuffer = device.receiveBuffer.slice(STATUS_FRAME_LENGTH);
        this._applyRealTelemetry(deviceId, frame, telemetry);
        this._resolveStatusTransaction(deviceId, frame, telemetry);
      } catch (err) {
        logger.warn(`Rejected PLC STAT frame [${device.config.name}]: ${err.message}`);
        this._logPlcEvent('ERROR', `Rejected STAT frame: ${err.message}`, null, frame);
        device.receiveBuffer = device.receiveBuffer.slice(1);
      }
    }
  }

  _emitProtocolResponse(deviceId, responseStr) {
    const device = this.devices.get(deviceId);
    const timestamp = new Date().toISOString();
    if (device) device.lastResponse = responseStr;
    this.emit('data:received', { deviceId, response: responseStr });
    this._logPlcEvent('STATUS', `RX: ${responseStr}`, null, responseStr);
    this.emit('plc:response', { deviceId, response: responseStr, timestamp });
  }

  _emitOpaqueResponse(deviceId, responseStr) {
    const device = this.devices.get(deviceId);
    if (device) device.lastResponse = responseStr;
    this.emit('data:received', { deviceId, response: responseStr });
    this._logPlcEvent('STATUS', `RX: ${responseStr}`, null, responseStr);
    this.emit('plc:response', { deviceId, response: responseStr, timestamp: new Date().toISOString() });
  }

  parseStatusFrame(frame) {
    const raw = String(frame || '');
    if (!raw.startsWith('STAT=')) throw new Error('STAT prefix is required');
    const fields = raw.slice(5).split(',');
    if (fields.length !== 15) throw new Error(`STAT requires 15 fields, received ${fields.length}`);

    const patterns = [/^\d$/, /^[01]$/, /^\d{4}$/, /^\d{4}$/, /^\d{4}$/, /^[01]$/, /^[01]$/, /^[01]$/, /^\d{4}$/, /^[01]$/, /^[01]$/, /^[01]$/, /^[01]$/, /^[01]$/, /^\d{2}$/];
    fields.forEach((value, index) => {
      if (!patterns[index].test(value)) throw new Error(`Invalid STAT field ${index + 1}: ${value}`);
    });

    const bool = (value) => value === '1';
    return {
      MachineState: Number(fields[0]),
      JobLoaded: bool(fields[1]),
      ProductID: Number(fields[2]),
      RecipeID: Number(fields[3]),
      TargetQty: Number(fields[4]),
      MachineReady: bool(fields[5]),
      MachineRunning: bool(fields[6]),
      MachineFault: bool(fields[7]),
      FaultCode: Number(fields[8]),
      AxisReady: bool(fields[9]),
      MoveBusy: bool(fields[10]),
      HaltBusy: bool(fields[11]),
      AxisPositioning: bool(fields[12]),
      HomeBusy: bool(fields[13]),
      MotionState: Number(fields[14]),
    };
  }

  _applyRealTelemetry(deviceId, frame, telemetry) {
    const device = this.devices.get(deviceId);
    if (!device?.connected || device.isDemo) {
      logger.warn(`Ignored STAT telemetry for non-REAL device ${deviceId}`);
      return;
    }

    const db = getDb();
    const tags = db.prepare('SELECT * FROM plc_tags WHERE device_id = ? AND is_monitored = 1').all(deviceId);
    const timestamp = new Date().toISOString();
    const updates = [];
    const insertValue = db.prepare('INSERT INTO plc_tag_values (tag_id, value, quality, timestamp) VALUES (?, ?, ?, ?)');
    db.transaction(() => {
      for (const tag of tags) {
        if (!Object.prototype.hasOwnProperty.call(telemetry, tag.tag_name)) continue;
        const value = telemetry[tag.tag_name];
        this.tagValues.set(tag.id, { value, quality: 'good', timestamp, source: 'plc-telemetry' });
        insertValue.run(tag.id, String(value), 'good', timestamp);
        updates.push({ tagId: tag.id, tagName: tag.tag_name, value, quality: 'good', unit: tag.unit, timestamp });
      }
    })();

    device.lastResponse = frame;
    device.lastTelemetryAt = timestamp;
    device.lastTelemetry = { ...telemetry };
    this._logPlcEvent('STATUS', `RX STAT: ${frame}`, null, frame);
    this.emit('data:received', { deviceId, response: frame });
    this.emit('plc:response', { deviceId, response: frame, timestamp });
    this.emit('tags:updated', { deviceId, tags: updates });
    this.emit('telemetry:updated', { deviceId, telemetry: { ...telemetry }, timestamp });
  }

  formatProtocolField(value, fieldName) {
    const raw = String(value ?? '').trim();
    if (!/^\d{1,4}$/.test(raw)) {
      throw new Error(`${fieldName} must be an integer from 0 to 9999`);
    }
    return raw.padStart(4, '0');
  }

  formatJobCommand(productId, recipeId, targetQty) {
    return `JOB=${this.formatProtocolField(productId, 'ProductID')},${this.formatProtocolField(recipeId, 'RecipeID')},${this.formatProtocolField(targetQty, 'TargetQty')}`;
  }

  normalizeCommand(commandStr) {
    const raw = String(commandStr || '').trim().toUpperCase();
    if (raw.startsWith('JOB=')) {
      const fields = raw.slice(4).split(',');
      if (fields.length !== 3) throw new Error('JOB requires ProductID, RecipeID, TargetQty');
      return this.formatJobCommand(fields[0], fields[1], fields[2]);
    }
    if (raw === 'START' || raw === 'START=0000') return 'START=0000';
    if (raw === 'STOP' || raw === 'STOP=0000') return 'STOP=0000';
    if (raw === 'HOME' || raw === 'HOME=0000') return 'HOME=0000';
    if (raw === 'RESET' || raw === 'RESET=0000') return 'RESET=0000';
    throw new Error(`Invalid Siemens TCP command: ${commandStr}. Expected JOB=PPPP,RRRR,QQQQ, START=0000, STOP=0000, HOME=0000, or RESET=0000.`);
  }

  _writeAscii(device, command) {
    return new Promise((resolve, reject) => {
      const socket = device.socket;
      if (!device.connected || device.isDemo || !socket || socket.destroyed || !socket.writable) {
        return reject(new Error(`Siemens PLC TCP socket disconnected (${device.config.ip_address}:${device.config.port})`));
      }
      const payload = Buffer.from(command, 'ascii');
      socket.write(payload, (err) => {
        if (err) return reject(new Error(`Socket write error: ${err.message}`));
        resolve({ payload, byteLength: payload.length, hex: payload.toString('hex') });
      });
    });
  }

  _enqueueMachineTransaction(device, command, expectedResponse, { priority = false } = {}) {
    return new Promise((resolve, reject) => {
      const transaction = { kind: 'machine', command, expectedResponse, resolve, reject };
      if (priority) device.machineQueue.unshift(transaction);
      else device.machineQueue.push(transaction);
      this._drainTransactions(device);
    });
  }

  _drainTransactions(device) {
    if (!device || device.activeTransaction) return;
    const next = device.machineQueue.shift();
    if (next) this._startTransaction(device, next);
  }

  _startTransaction(device, transaction) {
    if (device.activeTransaction) throw new Error(`PLC transaction already active for ${device.config.id}`);
    device.activeTransaction = transaction;
    transaction.settled = false;
    transaction.timeout = setTimeout(() => {
      this._finishTransaction(device, transaction, new Error(`PLC ${transaction.kind} response timeout for ${transaction.command}`));
    }, config.plc.responseTimeoutMs);

    this._writeAscii(device, transaction.command).catch((err) => {
      this._finishTransaction(device, transaction, err);
    });
  }

  _finishTransaction(device, transaction, error = null, response = null) {
    if (!transaction || transaction.settled || device.activeTransaction !== transaction) return false;
    transaction.settled = true;
    clearTimeout(transaction.timeout);
    device.activeTransaction = null;
    if (transaction.kind === 'status') device.statusPollPending = false;

    if (error) transaction.reject(error);
    else transaction.resolve(response);
    this._drainTransactions(device);
    return true;
  }

  _cancelTransactions(device, error) {
    const active = device.activeTransaction;
    if (active && !active.settled) {
      active.settled = true;
      clearTimeout(active.timeout);
      active.reject(error);
    }
    device.activeTransaction = null;
    device.statusPollPending = false;
    for (const queued of device.machineQueue.splice(0)) queued.reject(error);
  }

  _resolveAckTransaction(deviceId, ack) {
    const device = this.devices.get(deviceId);
    const transaction = device?.activeTransaction;
    if (!transaction || transaction.kind !== 'machine' || transaction.expectedResponse !== ack) {
      logger.warn(`PLC protocol warning: unexpected ${ack}; active=${transaction ? `${transaction.kind}:${transaction.expectedResponse || transaction.command}` : 'none'}`);
      this._logPlcEvent('ERROR', `Unexpected ${ack}; active transaction does not match`, null, ack);
      return false;
    }
    return this._finishTransaction(device, transaction, null, ack);
  }

  _resolveStatusTransaction(deviceId, frame, telemetry) {
    const device = this.devices.get(deviceId);
    const transaction = device?.activeTransaction;
    if (!transaction || transaction.kind !== 'status') {
      logger.warn(`PLC protocol warning: unsolicited STAT frame for device ${deviceId}`);
      return false;
    }
    return this._finishTransaction(device, transaction, null, { frame, telemetry });
  }

  async sendCommand(deviceId, commandStr) {
    const trimmedCmd = this.normalizeCommand(commandStr);
    const isJobCommand = trimmedCmd.startsWith('JOB=');
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
      const simulatedResponse = trimmedCmd === 'HOME=0000'
        ? `[DEMO] SENT ${trimmedCmd}`
        : `ACK ${trimmedCmd}`;
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

    const commandType = trimmedCmd.startsWith('JOB=') ? 'JOB' : trimmedCmd.split('=')[0];
    const expectedAck = COMMAND_ACK[commandType];
    const payload = Buffer.from(trimmedCmd, 'ascii');
    const socket = device.socket;
    const trace = {
      deviceId: device.config.id,
      ip: device.config.ip_address,
      port: device.config.port,
      connected: device.connected,
      socketDestroyed: socket?.destroyed ?? true,
      socketWritable: socket?.writable ?? false,
      command: trimmedCmd,
      byteLength: payload.length,
      hex: payload.toString('hex'),
      expectedAck,
    };
    if (isJobCommand) logger.info(`[PLC_JOB_TRACE] transaction queued ${JSON.stringify(trace)}`);

    return this._enqueueMachineTransaction(device, trimmedCmd, expectedAck, { priority: trimmedCmd === 'STOP=0000' }).then((ack) => {
      if (isJobCommand) logger.info(`[PLC_JOB_TRACE] transaction acknowledged deviceId=${device.config.id} command=${trimmedCmd} ack=${ack}`);
      device.lastCommand = trimmedCmd;
      this._logPlcEvent('COMMAND', `TX acknowledged: ${trimmedCmd}`, trimmedCmd, ack);
      const result = {
        success: true,
        deviceId: device.config.id,
        command: trimmedCmd,
        byteLength: payload.length,
        hex: payload.toString('hex'),
        writeStatus: 'ACKNOWLEDGED',
        response: ack,
        mode: 'REAL',
        timestamp: new Date().toISOString(),
      };
      this.emit('command:sent', result);
      return result;
    }).catch((err) => {
      if (isJobCommand) logger.error(`[PLC_JOB_TRACE] transaction failed deviceId=${device.config.id} error=${err.message}`);
      logger.error(`Siemens PLC transaction failed: ${err.message}`);
      this._logPlcEvent('ERROR', `TX failed ${trimmedCmd}: ${err.message}`, trimmedCmd);
      throw err;
    });
  }

  _resolveDevice(deviceId) {
    if (deviceId && this.devices.has(deviceId)) return this.devices.get(deviceId);
    return Array.from(this.devices.values())[0] || null;
  }

  async sendJob(deviceId, productId, recipeId, targetQty) {
    return this.sendCommand(deviceId, this.formatJobCommand(productId, recipeId, targetQty));
  }

  async sendStart(deviceId) {
    return this.sendCommand(deviceId, 'START=0000');
  }

  async sendStop(deviceId) {
    return this.sendCommand(deviceId, 'STOP=0000');
  }

  async sendHome(deviceId) {
    return this.sendCommand(deviceId, 'HOME=0000');
  }

  async sendReset(deviceId) {
    return this.sendCommand(deviceId, 'RESET=0000');
  }

  /**
   * Track last-commanded state for UI. This is not a fake PLC read —
   * it records what the server actually sent (or simulated in DEMO).
   */
  _applyCommandedState(deviceId, command) {
    const db = getDb();
    const tags = db.prepare('SELECT * FROM plc_tags WHERE device_id = ? AND is_monitored = 1').all(deviceId);
    const ts = new Date().toISOString();

    for (const tag of tags) {
      let val = undefined;
      if (command.startsWith('JOB=')) {
        const [productId, recipeId, targetQty] = command.slice(4).split(',').map(Number);
        if (tag.tag_name === 'JobLoaded') val = true;
        if (tag.tag_name === 'ProductID') val = productId;
        if (tag.tag_name === 'RecipeID') val = recipeId;
        if (tag.tag_name === 'TargetQty') val = targetQty;
      } else if (command === 'START=0000') {
        if (tag.tag_name === 'MachineRunning') val = true;
      } else if (command === 'STOP=0000') {
        if (tag.tag_name === 'MachineRunning') val = false;
      } else if (command === 'RESET=0000') {
        if (tag.tag_name === 'MachineRunning') val = false;
        if (tag.tag_name === 'JobLoaded') val = false;
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

  _startStatusPolling(deviceId) {
    this._stopStatusPolling(deviceId);
    const device = this.devices.get(deviceId);
    if (!device?.connected || device.isDemo) return;

    const timer = setInterval(() => {
      const current = this.devices.get(deviceId);
      if (!current?.connected || current.isDemo || current.activeTransaction || current.machineQueue.length > 0 || current.statusPollPending) return;
      this._requestStatusTransaction(current)
        .then(() => {
          logger.debug(`PLC STATUS transaction completed: deviceId=${deviceId}`);
        })
        .catch((err) => {
          logger.warn(`PLC STATUS transaction failed [${current.config.name}]: ${err.message}`);
        });
    }, config.plc.statusPollMs);
    this.statusPollTimers.set(deviceId, timer);
  }

  _requestStatusTransaction(device) {
    if (!device?.connected || device.isDemo || device.activeTransaction || device.machineQueue.length > 0 || device.statusPollPending) {
      return Promise.resolve({ skipped: true });
    }
    device.statusPollPending = true;
    return new Promise((resolve, reject) => {
      this._startTransaction(device, {
        kind: 'status',
        command: STATUS_REQUEST,
        expectedResponse: 'STAT',
        resolve,
        reject,
      });
    });
  }

  _stopStatusPolling(deviceId) {
    const timer = this.statusPollTimers.get(deviceId);
    if (timer) clearInterval(timer);
    this.statusPollTimers.delete(deviceId);
    const device = this.devices.get(deviceId);
    if (device) device.statusPollPending = false;
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
    throw new Error(`Direct tag writes are disabled for PLC ${deviceId || ''}; use the JOB/START/STOP/HOME/RESET commands`);
  }

  getTagValues(deviceId) {
    const db = getDb();
    const tags = db.prepare(`
      SELECT * FROM plc_tags
      WHERE device_id = ? AND is_monitored = 1
      ORDER BY CASE tag_name
        WHEN 'MachineState' THEN 1 WHEN 'JobLoaded' THEN 2 WHEN 'ProductID' THEN 3
        WHEN 'RecipeID' THEN 4 WHEN 'TargetQty' THEN 5 WHEN 'MachineReady' THEN 6
        WHEN 'MachineRunning' THEN 7 WHEN 'MachineFault' THEN 8 WHEN 'FaultCode' THEN 9
        WHEN 'AxisReady' THEN 10 WHEN 'MoveBusy' THEN 11 WHEN 'HaltBusy' THEN 12
        WHEN 'AxisPositioning' THEN 13 WHEN 'HomeBusy' THEN 14 WHEN 'MotionState' THEN 15
        ELSE 100 END, tag_name
    `).all(deviceId);
    const telemetryState = this.getTelemetrySnapshot(deviceId);
    return tags.map(tag => {
      const current = this.tagValues.get(tag.id);
      const currentValue = !current
        ? { value: null, quality: 'unknown', source: 'no-telemetry' }
        : telemetryState?.telemetryFresh
          ? current
          : { ...current, quality: 'stale' };
      return { ...tag, currentValue };
    });
  }

  getDeviceStatus(deviceId) {
    const device = this.devices.get(deviceId);
    if (!device) return null;
    const telemetryState = this.getTelemetrySnapshot(deviceId);
    return {
      deviceId,
      connected: device.connected,
      tcpConnected: device.connected,
      isDemo: device.isDemo,
      mode: device.isDemo ? 'DEMO' : (device.connected ? 'REAL' : 'OFFLINE'),
      lastCommand: device.lastCommand,
      lastResponse: device.lastResponse,
      lastTelemetryAt: device.lastTelemetryAt,
      telemetryAgeMs: telemetryState?.telemetryAgeMs ?? null,
      telemetryFresh: telemetryState?.telemetryFresh ?? false,
      telemetryHealthy: telemetryState?.telemetryHealthy ?? false,
      config: device.config,
    };
  }

  getTelemetrySnapshot(deviceId, now = Date.now()) {
    const device = this.devices.get(deviceId);
    if (!device) return null;
    const lastStatAt = device.lastTelemetryAt;
    const parsed = lastStatAt ? new Date(lastStatAt).getTime() : NaN;
    const telemetryAgeMs = Number.isFinite(parsed) ? Math.max(0, now - parsed) : null;
    const telemetryFresh = device.connected && !device.isDemo && telemetryAgeMs !== null
      && telemetryAgeMs <= config.plc.telemetryFreshMs;
    return {
      deviceId,
      connected: device.connected,
      tcpConnected: device.connected,
      isDemo: device.isDemo,
      mode: device.isDemo ? 'DEMO' : (device.connected ? 'REAL' : 'OFFLINE'),
      lastStatAt,
      telemetryAgeMs,
      telemetryFresh,
      telemetryHealthy: telemetryFresh && Boolean(device.lastTelemetry),
      telemetry: telemetryFresh && device.lastTelemetry ? { ...device.lastTelemetry } : null,
      staleTelemetry: !telemetryFresh && device.lastTelemetry ? { ...device.lastTelemetry } : null,
    };
  }

  waitForTelemetryAfter(deviceId, afterTimestamp, timeoutMs = config.plc.telemetryFreshMs) {
    const after = new Date(afterTimestamp).getTime();
    const current = this.getTelemetrySnapshot(deviceId);
    if (current?.telemetryFresh && new Date(current.lastStatAt).getTime() > after) return Promise.resolve(current);
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.removeListener('telemetry:updated', onTelemetry);
      };
      const onTelemetry = (event) => {
        if (event.deviceId !== deviceId || new Date(event.timestamp).getTime() <= after) return;
        cleanup();
        resolve(this.getTelemetrySnapshot(deviceId));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('telemetry_confirmation_timeout'));
      }, timeoutMs);
      this.on('telemetry:updated', onTelemetry);
    });
  }

  getAllStatuses() {
    return Array.from(this.devices.entries()).map(([id, device]) => {
      const telemetryState = this.getTelemetrySnapshot(id);
      return {
        deviceId: id,name: device.config.name,ip: device.config.ip_address,port: device.config.port,
        connected: device.connected,tcpConnected: device.connected,isDemo: device.isDemo,
        mode: device.isDemo ? 'DEMO' : (device.connected ? 'REAL' : 'OFFLINE'),lastCommand: device.lastCommand,
        lastTelemetryAt: device.lastTelemetryAt,telemetryAgeMs: telemetryState?.telemetryAgeMs ?? null,
        telemetryFresh: telemetryState?.telemetryFresh ?? false,telemetryHealthy: telemetryState?.telemetryHealthy ?? false,
        protocol: 's7-tcp',
      };
    });
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
    for (const timer of this.statusPollTimers.values()) clearInterval(timer);
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);

    for (const [id, device] of this.devices.entries()) {
      this._cancelTransactions(device, new Error('PLC service shutting down'));
      if (device.socket) {
        try { device.socket.destroy(); } catch { /* ignore */ }
      }
      this._updateDeviceStatus(id, 'disconnected');
    }

    this.devices.clear();
    this.pollTimers.clear();
    this.statusPollTimers.clear();
    this.reconnectTimers.clear();
    logger.info('Siemens PLC service shut down complete');
  }
}

const plcService = new SiemensPlcService();
module.exports = plcService;
