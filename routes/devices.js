import { Router } from 'express';
import { listDevices, getAgentStatus, recordAgentConnection, disconnectAgent, getDevice, getPreference } from '../services/storage.js';
import { deviceSockets } from '../services/websocket.js';
import { resolveUserId } from '../services/user-resolver.js';
import { asyncRoute } from '../middleware/errorHandler.js';

const router = Router();

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

export default router;
