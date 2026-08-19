const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const config = require('../config');
const logger = require('../config/logger');
const plcService = require('../services/plc/plcService');
const scannerService = require('../services/scanner/scannerService');
const printerService = require('../services/printer/printerService');

let wss = null;
const clients = new Map(); // clientId -> { ws, userId, role, subscriptions }

/**
 * Initialize WebSocket server
 */
function initWebSocket(server) {
  wss = new WebSocket.Server({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const clientId = generateClientId();

    // Authenticate connection
    const token = extractToken(req);
    if (!token) {
      ws.close(4001, 'Authentication required');
      return;
    }

    try {
      const decoded = jwt.verify(token, config.jwt.secret);
      clients.set(clientId, {
        ws,
        userId: decoded.id,
        username: decoded.username,
        role: decoded.role,
        subscriptions: new Set(['plc:data', 'alarms', 'scanner', 'printer', 'job', 'job:updated']),
        lastPing: Date.now(),
      });

      logger.info(`WebSocket client connected: ${decoded.username} (${clientId})`);

      // Send welcome message
      sendToClient(clientId, {
        type: 'connected',
        payload: {
          clientId,
          message: 'Connected to PLC Web System',
          timestamp: new Date().toISOString(),
        },
      });

      // Send current PLC status immediately
      const statuses = plcService.getAllStatuses();
      sendToClient(clientId, {
        type: 'plc:status',
        payload: { devices: statuses },
      });

    } catch (err) {
      ws.close(4001, 'Invalid token');
      return;
    }

    // Handle messages from client
    ws.on('message', (data) => {
      handleClientMessage(clientId, data);
    });

    ws.on('close', () => {
      logger.info(`WebSocket client disconnected: ${clientId}`);
      clients.delete(clientId);
    });

    ws.on('error', (err) => {
      logger.warn(`WebSocket error for ${clientId}: ${err.message}`);
      clients.delete(clientId);
    });

    // Ping/pong heartbeat
    ws.on('pong', () => {
      const client = clients.get(clientId);
      if (client) client.lastPing = Date.now();
    });
  });

  // Heartbeat interval
  const heartbeatInterval = setInterval(() => {
    const now = Date.now();
    clients.forEach((client, clientId) => {
      if (now - client.lastPing > config.websocket.heartbeatIntervalMs * 2) {
        logger.warn(`WebSocket client ${clientId} timed out`);
        client.ws.terminate();
        clients.delete(clientId);
        return;
      }
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.ping();
      }
    });
  }, config.websocket.heartbeatIntervalMs);

  wss.on('close', () => clearInterval(heartbeatInterval));

  // Subscribe to PLC events
  plcService.on('tags:updated', ({ deviceId, tags }) => {
    broadcast('plc:data', { deviceId, tags });
  });

  plcService.on('device:connected', (data) => {
    broadcast('plc:connected', data);
  });

  plcService.on('device:disconnected', (data) => {
    broadcast('plc:disconnected', data);
  });

  plcService.on('command:sent', (data) => {
    broadcast('plc:command', data);
  });

  plcService.on('plc:response', (data) => {
    broadcast('plc:response', data);
  });

  // Subscribe to scanner events
  scannerService.on('scan:processed', (data) => {
    broadcast('scanner:result', data);
  });

  printerService.on('status', (data) => {
    broadcast('printer:status', data);
  });

  // Subscribe to workflow events
  const workflowService = require('../services/workflow/workflowService');
  workflowService.on('job:updated', (data) => {
    broadcast('job:updated', data);
  });
  workflowService.on('job:selected', (data) => {
    broadcast('job:selected', data);
  });

  logger.info('WebSocket server initialized on /ws');
  return wss;
}

/**
 * Handle incoming message from client
 */
function handleClientMessage(clientId, rawData) {
  const client = clients.get(clientId);
  if (!client) return;

  try {
    const message = JSON.parse(rawData.toString());
    const { type, payload } = message;

    switch (type) {
      case 'ping':
        sendToClient(clientId, { type: 'pong', payload: { timestamp: Date.now() } });
        break;

      case 'subscribe':
        if (payload.events) {
          payload.events.forEach(event => client.subscriptions.add(event));
          logger.debug(`Client ${clientId} subscribed to: ${payload.events.join(', ')}`);
        }
        break;

      case 'unsubscribe':
        if (payload.events) {
          payload.events.forEach(event => client.subscriptions.delete(event));
        }
        break;

      case 'scanner:result':
        // Process barcode scan from browser camera
        scannerService.processScanResult({
          ...payload,
          userId: client.userId,
        }).catch(err => {
          sendToClient(clientId, {
            type: 'error',
            payload: { message: err.message, source: 'scanner' },
          });
        });
        break;

      case 'plc:write':
        // Write tag value (admin/operator only)
        if (client.role === 'viewer') {
          sendToClient(clientId, {
            type: 'error',
            payload: { message: 'Unauthorized: viewer role cannot write to PLC' },
          });
          return;
        }
        plcService.writeTag(payload.deviceId, payload.tagId, payload.value)
          .then(result => sendToClient(clientId, { type: 'plc:write:result', payload: result }))
          .catch(err => sendToClient(clientId, {
            type: 'error',
            payload: { message: err.message, source: 'plc' },
          }));
        break;

      default:
        logger.debug(`Unknown WS message type: ${type}`);
    }
  } catch (err) {
    logger.warn(`Failed to parse WebSocket message from ${clientId}: ${err.message}`);
  }
}

/**
 * Send message to a specific client
 */
function sendToClient(clientId, data) {
  const client = clients.get(clientId);
  if (!client || client.ws.readyState !== WebSocket.OPEN) return;

  try {
    client.ws.send(JSON.stringify(data));
  } catch (err) {
    logger.warn(`Failed to send to client ${clientId}: ${err.message}`);
  }
}

/**
 * Broadcast to all subscribed clients
 */
function broadcast(eventType, payload) {
  const category = eventType.split(':')[0];
  clients.forEach((client, clientId) => {
    if (
      client.ws.readyState === WebSocket.OPEN &&
      (client.subscriptions.has(eventType) || client.subscriptions.has(category))
    ) {
      sendToClient(clientId, { type: eventType, payload });
    }
  });
}

/**
 * Get connected clients count
 */
function getClientCount() {
  return clients.size;
}

function extractToken(req) {
  const url = new URL(req.url, 'ws://localhost');
  return url.searchParams.get('token');
}

function generateClientId() {
  return `client_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

module.exports = { initWebSocket, broadcast, getClientCount };
