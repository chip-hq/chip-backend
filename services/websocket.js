import { WebSocketServer, WebSocket } from 'ws';
import { upsertDevice, setDeviceConnected, updateJob } from './storage.js';

export const deviceSockets = new Map();

export function setupWebSocket(server) {
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws, req) => {
    let deviceId = 'default_device';

    deviceSockets.set(deviceId, ws);
    upsertDevice({ deviceId, chip: 'ESP32', connected: true });
    console.log(`[WS] New client connection from ${req.socket.remoteAddress}`);

    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message.toString());

        if (data.type === 'register') {
          deviceId = data.deviceId || 'default_device';
          const userId = data.userId || data.uid || null;
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
