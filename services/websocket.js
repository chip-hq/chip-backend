import { WebSocketServer, WebSocket } from 'ws';
import {
  upsertDevice,
  setDeviceConnected,
  updateJob,
  verifyDeviceToken,
  pushTelemetry,
  reportOtaStatus,
  latestReleaseForDevice,
} from './storage.js';

/**
 * Realtime hub — one connectivity model for commands, telemetry, and OTA.
 *
 * Two socket roles share this server:
 *  - `dashboard`: browser tabs (existing flash flow). Keyed by deviceId in
 *    `deviceSockets`, exactly as before so /api/flash keeps working.
 *  - `device`: ESP32 boards on WiFi running the Chip Agent firmware, authed
 *    with the per-board token from POST /api/devices/claim. Tracked in
 *    `deviceLinks`. Commands and OTA triggers addressed to a deviceId go
 *    down this socket; telemetry / status / ota_status come back up it and
 *    are fanned out to that user's dashboards.
 *
 * Boards without WiFi stay reachable the old way: USB serial through the
 * dashboard browser relay. Presence = wifi link alive OR a dashboard
 * holding the deviceId. MQTT is the documented migration path if fan-out
 * ever outgrows a single Node process (see README).
 */

/** Dashboard browser sockets, keyed by deviceId (unchanged legacy behavior). */
export const deviceSockets = new Map();

/** Direct board links: deviceId -> { ws, userId, lastSeen, firmwareVersion }. */
export const deviceLinks = new Map();

/** Boards are declared offline after this long without any frame. */
const DEVICE_TIMEOUT_MS = 95_000;

/** Keepalive interval — Railway/proxies drop idle WS ~60s without traffic. */
const HEARTBEAT_MS = 25_000;

function sendJson(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** Deliver a message to a board over its direct WiFi link. Returns delivered. */
export function sendToDevice(deviceId, obj) {
  const link = deviceLinks.get(deviceId);
  if (!link) return false;
  const ok = sendJson(link.ws, obj);
  if (ok) link.lastSeen = Date.now();
  return ok;
}

/** Push a message to every open dashboard socket owned by a user. */
export function broadcastToUserDashboards(userId, obj) {
  if (!userId) return 0;
  let n = 0;
  for (const ws of deviceSockets.values()) {
    if (ws.userId === userId && sendJson(ws, obj)) n += 1;
  }
  return n;
}

/** Where can we currently reach this board? 'wifi' | 'usb' | null. */
export function getDeviceRoute(deviceId) {
  const link = deviceLinks.get(deviceId);
  if (link && link.ws.readyState === WebSocket.OPEN) return 'wifi';
  const dash = deviceSockets.get(deviceId);
  if (dash && dash.readyState === WebSocket.OPEN) return 'usb';
  return null;
}

/** Recompute the stored online flag from live sockets (either transport). */
export function recomputePresence(deviceId) {
  const online = getDeviceRoute(deviceId) !== null;
  setDeviceConnected(deviceId, online);
  return online;
}

/**
 * If a release is pending for this board (newer than what it runs),
 * push the OTA trigger now — this is what wakes offline boards up
 * into an update as soon as they check in.
 */
async function deliverPendingOta(deviceId, userId, firmwareVersion) {
  try {
    const release = await latestReleaseForDevice(deviceId, userId);
    if (!release) return;
    if (firmwareVersion && release.version === firmwareVersion) return;
    const path = `/api/ota/firmware?deviceId=${encodeURIComponent(deviceId)}&token=${encodeURIComponent('__DEVICE_TOKEN__')}`;
    if (sendToDevice(deviceId, {
      type: 'ota_update',
      version: release.version,
      path,
      sha256: release.sha256,
      size: release.size,
    })) {
      reportOtaStatus(deviceId, { status: 'triggered', version: release.version });
    }
  } catch (err) {
    console.error('[WS] deliverPendingOta failed:', err?.message ?? err);
  }
}

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

  // Presence sweeper: boards that go quiet past the timeout read offline.
  // (The `ws` ping above only proves TCP is alive; devices confirm with hello.)
  const presenceTimer = setInterval(() => {
    const now = Date.now();
    for (const [deviceId, link] of deviceLinks.entries()) {
      if (now - link.lastSeen > DEVICE_TIMEOUT_MS) {
        console.log(`[WS] Device link timed out: ${deviceId}`);
        try { link.ws.close(4000, 'presence timeout'); } catch { /* ignore */ }
        deviceLinks.delete(deviceId);
        recomputePresence(deviceId);
        broadcastToUserDashboards(link.userId, {
          type: 'device_status',
          deviceId,
          connected: getDeviceRoute(deviceId) !== null,
          transport: getDeviceRoute(deviceId),
        });
      }
    }
  }, 30_000);

  wss.on('close', () => {
    clearInterval(heartbeatTimer);
    clearInterval(presenceTimer);
  });

  wss.on('connection', (ws, req) => {
    let deviceId = 'default_device';
    let userId = null;
    let role = 'dashboard';
    ws.isAlive = true;

    try {
      const url = new URL(req.url, 'http://localhost');
      userId = url.searchParams.get('userId') || url.searchParams.get('uid') || null;
      const roleParam = (url.searchParams.get('role') || '').toLowerCase();
      if (roleParam === 'device') role = 'device';
      const qpDevice = url.searchParams.get('deviceId');
      if (qpDevice) deviceId = qpDevice;
      ws.deviceToken = url.searchParams.get('token') || null;
    } catch {
      // non-fatal
    }

    ws.userId = userId;
    ws.socketRole = role;

    if (role === 'device') {
      // Defer registration until the hello frame carries a valid token.
      console.log(`[WS] Device socket opened from ${req.socket.remoteAddress} (awaiting hello)`);
    } else {
      deviceSockets.set(deviceId, ws);
      upsertDevice({ deviceId, chip: 'ESP32', connected: true, userId, transport: 'usb' });
      console.log(`[WS] New client connection from ${req.socket.remoteAddress}${userId ? ` [User: ${userId}]` : ''}`);
    }

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

        // ── Board frames (role=device, token required) ──────────────────
        if (data.type === 'hello') {
          handleDeviceHello(ws, data, req).catch((err) => {
            console.error('[WS] hello failed:', err?.message ?? err);
            try { ws.close(4401, 'unauthorized'); } catch { /* ignore */ }
          });
          return;
        }

        if (role === 'device' || data.type === 'heartbeat' || data.type === 'telemetry' || data.type === 'ota_status' || data.type === 'cmd_ack') {
          handleDeviceFrame(ws, data);
          return;
        }

        // ── Dashboard frames (legacy behavior preserved) ────────────────
        if (data.type === 'register') {
          deviceId = data.deviceId || 'default_device';
          userId = data.userId || data.uid || userId || null;
          ws.userId = userId;
          deviceSockets.set(deviceId, ws);
          upsertDevice({
            deviceId,
            chip: data.chip || 'ESP32',
            board: typeof data.board === 'string' ? data.board : undefined,
            connected: data.connected ?? true,
            userId,
            transport: 'usb',
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
      if (ws.socketRole === 'device' && ws.deviceId) {
        const id = ws.deviceId;
        console.log(`[WS] Device link closed: ${id}`);
        if (deviceLinks.get(id)?.ws === ws) deviceLinks.delete(id);
        const online = recomputePresence(id);
        broadcastToUserDashboards(ws.userId, {
          type: 'device_status',
          deviceId: id,
          connected: online,
          transport: getDeviceRoute(id),
        });
        return;
      }
      console.log(`[WS] Connection closed for ${deviceId}`);
      if (deviceSockets.get(deviceId) === ws) {
        deviceSockets.delete(deviceId);
      }
      // A live WiFi link keeps the board online even with no dashboard open.
      recomputePresence(deviceId);
    });

    ws.on('error', (err) => {
      console.error(`[WS] Error on ${deviceId}:`, err);
    });
  });

  async function handleDeviceHello(ws, data, req) {
    const id = String(data.deviceId || '').replace(/[^\w.\-]/g, '_').slice(0, 64);
    if (!id) {
      ws.close(4400, 'deviceId required');
      return;
    }
    const authed = await verifyDeviceToken(id, data.token || ws.deviceToken);
    if (!authed) {
      console.log(`[WS] Rejected device hello for ${id} (bad token)`);
      ws.close(4401, 'unauthorized');
      return;
    }
    deviceId = id;
    userId = authed.userId || data.userId || userId || null;
    ws.deviceId = id;
    ws.userId = userId;
    const firmwareVersion = typeof data.firmwareVersion === 'string' ? data.firmwareVersion.slice(0, 32) : null;
    deviceLinks.set(id, {
      ws,
      userId,
      lastSeen: Date.now(),
      firmwareVersion,
    });
    upsertDevice({
      deviceId: id,
      chip: data.chip || authed.chip || 'ESP32',
      connected: true,
      userId,
      transport: 'wifi',
      firmwareVersion,
      ip: req.socket.remoteAddress || null,
    });
    console.log(`[WS] Device online: ${id}${firmwareVersion ? ` fw=${firmwareVersion}` : ''}${userId ? ` [User: ${userId}]` : ''}`);
    sendJson(ws, { type: 'welcome', deviceId: id, serverTime: Date.now() });
    broadcastToUserDashboards(userId, {
      type: 'device_status',
      deviceId: id,
      connected: true,
      transport: 'wifi',
      firmwareVersion,
    });
    try {
      // A board checking in on the new version proves the last update healthy.
      if (firmwareVersion && typeof otaHooks.noteVersion === 'function') {
        otaHooks.noteVersion(id, firmwareVersion);
      }
    } catch { /* never break hello on bookkeeping */ }
    // Offline-published updates are waiting: trigger now.
    await deliverPendingOta(id, userId, firmwareVersion);
  }

  function handleDeviceFrame(ws, data) {
    const id = ws.deviceId || String(data.deviceId || '').replace(/[^\w.\-]/g, '_');
    if (!id || ws.socketRole !== 'device') return;
    const link = deviceLinks.get(id);
    if (!link || link.ws !== ws) return;
    link.lastSeen = Date.now();

    if (data.type === 'heartbeat') {
      if (typeof data.firmwareVersion === 'string') {
        link.firmwareVersion = data.firmwareVersion.slice(0, 32);
        upsertDevice({ deviceId: id, connected: true, firmwareVersion: link.firmwareVersion });
      } else {
        upsertDevice({ deviceId: id, connected: true });
      }
      return;
    }

    if (data.type === 'telemetry') {
      const point = pushTelemetry(id, data.data && typeof data.data === 'object' ? data.data : {});
      upsertDevice({ deviceId: id, connected: true });
      broadcastToUserDashboards(link.userId, {
        type: 'telemetry',
        deviceId: id,
        t: point.t,
        data: point.data,
      });
      return;
    }

    if (data.type === 'ota_status') {
      const status = String(data.status || 'unknown').slice(0, 32);
      const version = typeof data.version === 'string' ? data.version.slice(0, 32) : null;
      reportOtaStatus(id, { status, version, error: typeof data.error === 'string' ? data.error.slice(0, 300) : null });
      if (version && (status === 'applied' || status === 'healthy')) {
        link.firmwareVersion = version;
        upsertDevice({ deviceId: id, connected: true, firmwareVersion: version });
      }
      broadcastToUserDashboards(link.userId, {
        type: 'ota_status',
        deviceId: id,
        status,
        version,
      });
      // Rollout/bookkeeping advancement is handled by the OTA route polling
      // this same status store; see routes/ota.js noteOnOtaStatus hook below.
      try {
        const { noteOtaStatus } = otaHooks;
        if (typeof noteOtaStatus === 'function') noteOtaStatus(id, status, version);
      } catch { /* never break the socket on bookkeeping */ }
      return;
    }

    if (data.type === 'cmd_ack') {
      broadcastToUserDashboards(link.userId, {
        type: 'cmd_ack',
        deviceId: id,
        cmdId: data.cmdId ?? null,
        ok: data.ok !== false,
        result: typeof data.result === 'string' ? data.result.slice(0, 500) : null,
      });
    }
  }

  return wss;
}

// Late-bound hook so routes/ota.js can react to device OTA reports
// without a websocket.js <-> ota.js import cycle.
export const otaHooks = {
  noteOtaStatus: null,
};
