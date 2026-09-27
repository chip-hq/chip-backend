import { randomUUID } from 'crypto';
import { Router } from 'express';
import {
  listDevices,
  getAgentStatus,
  recordAgentConnection,
  disconnectAgent,
  getDevice,
  getPreference,
  claimDevice,
  getTelemetry,
} from '../services/storage.js';
import { deviceSockets, deviceLinks, sendToDevice, getDeviceRoute } from '../services/websocket.js';
import { getPlatformForChip, resolveBoard } from '../services/platforms.js';
import { resolveUserId } from '../services/user-resolver.js';
import { asyncRoute } from '../middleware/errorHandler.js';

const router = Router();

/** Attach the recognised hardware platform ({id, vendor, label, status}) from a chip name. */
function platformOf(chip, boardSlug = null) {
  if (boardSlug) {
    const r = resolveBoard(boardSlug);
    if (r) {
      const p = r.platform;
      return { id: p.id, vendor: p.vendor, label: p.label, status: p.status };
    }
  }
  const p = getPlatformForChip(chip);
  if (!p) return null;
  return { id: p.id, vendor: p.vendor, label: p.label, status: p.status };
}

router.get('/api/devices', asyncRoute(async (req, res) => {
  const targetUserId = req.userId || (typeof req.query.userId === 'string' ? req.query.userId : null);

  if (req.userId) {
    // Detect agent type from token audience or User-Agent header
    const ua = (req.headers['user-agent'] || '').toLowerCase();
    const aud = (req.tokenPayload?.aud || req.tokenPayload?.client_id || '').toLowerCase();
    let clientName = 'MCP Agent';
    let clientKey = 'mcpagent';
    if (aud.includes('claude') || ua.includes('claude') || ua.includes('anthropic')) {
      clientName = 'Claude'; clientKey = 'claude';
    } else if (aud.includes('chatgpt') || ua.includes('chatgpt') || ua.includes('openai')) {
      clientName = 'ChatGPT'; clientKey = 'chatgpt';
    }
    recordAgentConnection({
      userId: req.userId,
      clientName,
      clientKey,
      email: req.userEmail || null,
    });
  }

  let stored = await listDevices(targetUserId);
  const storedMap = new Map(stored.map((d) => [d.deviceId, d]));

  for (const [id, socket] of deviceSockets.entries()) {
    const socketUser = socket.userId || null;
    const matchesUser = !targetUserId || socketUser === targetUserId || !socketUser;

    if (matchesUser) {
      if (storedMap.has(id)) {
        storedMap.get(id).connected = true;
      } else {
        const dev = await getDevice(id);
        storedMap.set(id, {
          deviceId: id,
          chip: dev?.chip || 'ESP32',
          connected: true,
          userId: targetUserId || socketUser,
        });
      }
    }
  }

  // Direct WiFi board links (Chip Agent firmware) count as connected too.
  for (const [id, link] of deviceLinks.entries()) {
    if (link.ws.readyState !== 1) continue;
    const matchesUser = !targetUserId || link.userId === targetUserId || !link.userId;
    if (!matchesUser) continue;
    if (storedMap.has(id)) {
      storedMap.get(id).connected = true;
      storedMap.get(id).transport = 'wifi';
      if (link.firmwareVersion) storedMap.get(id).firmwareVersion = link.firmwareVersion;
    } else {
      const dev = await getDevice(id);
      storedMap.set(id, {
        deviceId: id,
        chip: dev?.chip || 'ESP32',
        connected: true,
        transport: 'wifi',
        firmwareVersion: link.firmwareVersion || dev?.firmwareVersion || null,
        userId: targetUserId || link.userId,
      });
    }
  }

  // Live reachability per board: wifi (direct) | usb (browser relay) | null.
  // Platform per board: recognised from the chip name (esptool detect) or
  // the claimed board slug — this is the "which platform is it on" badge.
  for (const [id, dev] of storedMap.entries()) {
    dev.route = getDeviceRoute(id);
    if (dev.route) dev.connected = true;
    dev.platform = platformOf(dev.chip, dev.board ?? null);
  }

  const userIdForPref = await resolveUserId(req);
  const companionRequired = await getPreference(userIdForPref, 'webCompanion', true);

  res.json({
    devices: Array.from(storedMap.values()),
    preferences: {
      webCompanion: companionRequired,
    },
  });
}));

router.get('/api/agents/status', asyncRoute(async (req, res) => {
  const targetUserId = await resolveUserId(req);
  const status = await getAgentStatus(targetUserId);
  res.json(status);
}));

router.post('/api/agents/disconnect', asyncRoute(async (req, res) => {
  const targetUserId = await resolveUserId(req);
  disconnectAgent(targetUserId);
  res.json({ ok: true, connected: false });
}));

// ── Fleet: identity, commands, telemetry ───────────────────────────────────

/**
 * Claim a board: binds a stable deviceId to the caller and issues the
 * device token baked into firmware (CHIP_DEVICE_ID / CHIP_DEVICE_TOKEN).
 * Re-claiming rotates the token; old firmware stops authenticating.
 */
router.post('/api/devices/claim', asyncRoute(async (req, res) => {
  const userId = await resolveUserId(req);
  const { deviceId = 'default_device', chip = 'ESP32', board = null } = req.body ?? {};
  const doc = await claimDevice({ deviceId, chip, userId, board });
  res.json({
    deviceId: doc.deviceId,
    chip: doc.chip,
    platform: platformOf(doc.chip, doc.board ?? board),
    token: doc.token,
    userId: doc.userId,
    message: 'Bake CHIP_DEVICE_ID and CHIP_DEVICE_TOKEN into firmware (see GET /api/agent/firmware). Shown once — reclaim to rotate.',
  });
}));

/**
 * Send a command to a board over its live channel. WiFi boards get it
 * direct; USB-tethered boards must use the dashboard serial console.
 */
router.post('/api/devices/:deviceId/cmd', asyncRoute(async (req, res) => {
  const deviceId = String(req.params.deviceId);
  const { command, args = {}, cmdId = `cmd_${randomUUID().slice(0, 8)}` } = req.body ?? {};
  if (!command || typeof command !== 'string') {
    return res.status(400).json({ error: '"command" (string) is required, e.g. reboot, status, ota_check.' });
  }
  const delivered = sendToDevice(deviceId, { type: 'cmd', cmdId, command, args });
  if (!delivered) {
    const route = getDeviceRoute(deviceId);
    return res.status(404).json({
      error: `Device "${deviceId}" is not reachable over WiFi${route === 'usb' ? ' (USB-tethered: send via the dashboard serial console instead)' : ''}.`,
      delivered: false,
      route,
    });
  }
  res.json({ delivered: true, route: 'wifi', deviceId, cmdId, command });
}));

/** Recent telemetry points for a board, newest first. */
router.get('/api/devices/:deviceId/telemetry', asyncRoute(async (req, res) => {
  const deviceId = String(req.params.deviceId);
  const points = await getTelemetry(deviceId, req.query.limit);
  res.json({ deviceId, count: points.length, points });
}));

/** Last known OTA state for a board (queued/downloading/applied/failed/…). */
router.get('/api/devices/:deviceId/ota', asyncRoute(async (req, res) => {
  const deviceId = String(req.params.deviceId);
  const dev = await getDevice(deviceId);
  res.json({
    deviceId,
    firmwareVersion: dev?.firmwareVersion ?? null,
    route: getDeviceRoute(deviceId),
    ota: dev?.ota ?? null,
  });
}));

export default router;
