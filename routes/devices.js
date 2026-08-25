import { Router } from 'express';
import { listDevices, getAgentStatus, recordAgentConnection, getDevice, getPreference } from '../services/storage.js';
import { deviceSockets } from '../services/websocket.js';
import { resolveUserId } from '../services/user-resolver.js';
import { asyncRoute } from '../middleware/errorHandler.js';

const router = Router();

router.get('/api/devices', asyncRoute(async (req, res) => {
  const targetUserId = req.userId || (typeof req.query.userId === 'string' ? req.query.userId : null);

  if (req.userId) {
    recordAgentConnection({
      userId: req.userId,
      clientName: 'Claude / MCP Agent',
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

export default router;
