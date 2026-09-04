import { WebSocketServer, WebSocket } from 'ws';
import { upsertDevice, setDeviceConnected, updateJob } from './storage.js';

export const deviceSockets = new Map();

/** Keepalive interval — Railway/proxies drop idle WS ~60s without traffic. */
const HEARTBEAT_MS = 25_000;

export function setupWebSocket(server) {
  const wss = new WebSocketServer({ server });

  const heartbeatTimer = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        console.log('[WS] Terminating unresponsive client');
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        // Protocol-level ping (browser auto-pongs) + app-level ping for strict proxies
        ws.ping();
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping', t: Date.now() }));
        }
      } catch {
        ws.terminate();
      }
    }
  }, HEARTBEAT_MS);

  wss.on('close', () => clearInterval(heartbeatTimer));

  wss.on('connection', (ws, req) => {
    let deviceId = 'default_device';
    let userId = null;
    ws.isAlive = true;

    try {
      const url = new URL(req.url, 'http://localhost');
      userId = url.searchParams.get('userId') || url.searchParams.get('uid') || null;
    } catch {
      // non-fatal
    }

    ws.userId = userId;
    deviceSockets.set(deviceId, ws);
    upsertDevice({ deviceId, chip: 'ESP32', connected: true, userId });
    console.log(`[WS] New client connection from ${req.socket.remoteAddress}${userId ? ` [User: ${userId}]` : ''}`);

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message.toString());

        if (data.type === 'pong' || data.type === 'ping') {
          ws.isAlive = true;
          if (data.type === 'ping' && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'pong', t: Date.now() }));
          }
          return;
        }

        if (data.type === 'register') {
          deviceId = data.deviceId || 'default_device';
          userId = data.userId || data.uid || userId || null;
          ws.userId = userId;
          deviceSockets.set(deviceId, ws);
          upsertDevice({
            deviceId,
            chip: data.chip || 'ESP32',
            connected: data.connected ?? true,
            userId,
          });
          console.log(`[WS] Device registered: ${deviceId} (${data.chip || 'ESP32'})${userId ? ` [User: ${userId}]` : ''}`);
          ws.send(JSON.stringify({ type: 'registered', deviceId, userId, status: 'ok' }));
        }

        if (data.type === 'flash_progress') {
          updateJob(data.jobId, {
            progress: data.progress,
            status: data.status || 'flashing',
            logLine: data.logLine,
          });
        }

        if (data.type === 'flash_complete') {
          updateJob(data.jobId, {
            progress: 100,
            status: 'done',
            logLine: 'Flash successfully completed.',
          });
        }

        if (data.type === 'flash_error') {
          updateJob(data.jobId, {
            status: 'error',
            error: data.error,
            logLine: `Error: ${data.error}`,
          });
        }
      } catch (err) {
        console.error('[WS] Failed to parse message:', err);
      }
    });

    ws.on('close', () => {
      console.log(`[WS] Connection closed for ${deviceId}`);
      if (deviceSockets.get(deviceId) === ws) {
        deviceSockets.delete(deviceId);
      }
      setDeviceConnected(deviceId, false);
    });

    ws.on('error', (err) => {
      console.error(`[WS] Error on ${deviceId}:`, err);
    });
  });

  return wss;
}
