import { WebSocketServer, WebSocket } from 'ws';
import { updateJob } from './storage.js';

// Browser sockets are retained only as the USB flashing relay. Board
// registration, WiFi presence, commands, telemetry, and OTA are removed.
export const deviceSockets = new Map();

function sendJson(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(obj));
    return true;
  } catch {
    return false;
  }
}

export function setupWebSocket(server) {
  const wss = new WebSocketServer({ server });
  const heartbeatTimer = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
        sendJson(ws, { type: 'ping', t: Date.now() });
      } catch {
        ws.terminate();
      }
    }
  }, 25_000);

  wss.on('close', () => clearInterval(heartbeatTimer));

  wss.on('connection', (ws, req) => {
    let deviceId = 'default_device';
    ws.isAlive = true;
    ws.userId = null;

    try {
      const url = new URL(req.url, 'http://localhost');
      ws.userId = url.searchParams.get('userId') || url.searchParams.get('uid') || null;
      deviceId = url.searchParams.get('deviceId') || deviceId;
    } catch {
      // Use the default browser relay identity.
    }

    deviceSockets.set(deviceId, ws);

    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message.toString());
        if (data.type === 'pong' || data.type === 'ping') {
          ws.isAlive = true;
          if (data.type === 'ping') sendJson(ws, { type: 'pong', t: Date.now() });
          return;
        }

        // The dashboard identifies the USB relay with a logical device id.
        if (data.type === 'register') {
          if (deviceSockets.get(deviceId) === ws) deviceSockets.delete(deviceId);
          deviceId = data.deviceId || 'default_device';
          ws.userId = data.userId || data.uid || ws.userId || null;
          deviceSockets.set(deviceId, ws);
          sendJson(ws, { type: 'registered', deviceId, status: 'ok' });
          return;
        }

        if (data.type === 'flash_progress') {
          updateJob(data.jobId, { progress: data.progress, status: data.status || 'flashing', logLine: data.logLine });
        } else if (data.type === 'flash_complete') {
          updateJob(data.jobId, { progress: 100, status: 'done', logLine: 'Flash successfully completed.' });
        } else if (data.type === 'flash_error') {
          updateJob(data.jobId, { status: 'error', error: data.error, logLine: `Error: ${data.error}` });
        }
      } catch (err) {
        console.error('[WS] Failed to parse message:', err);
      }
    });

    ws.on('close', () => {
      if (deviceSockets.get(deviceId) === ws) deviceSockets.delete(deviceId);
    });
    ws.on('error', (err) => console.error(`[WS] Error on ${deviceId}:`, err));
  });

  return wss;
}
