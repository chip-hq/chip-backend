import { Router } from 'express';
import { listDevices, getAgentStatus } from '../services/storage.js';
import { deviceSockets } from '../services/websocket.js';
import { resolveUserId } from '../services/user-resolver.js';
import { asyncRoute } from '../middleware/errorHandler.js';

const router = Router();

router.get('/api/devices', asyncRoute(async (req, res) => {
  const targetUserId = req.userId || (typeof req.query.userId === 'string' ? req.query.userId : null);
  const stored = await listDevices(targetUserId);
  const storedMap = new Map(stored.map((d) => [d.deviceId, d]));

  for (const [id] of deviceSockets.entries()) {
    if (storedMap.has(id)) {
      storedMap.get(id).connected = true;
    } else if (!targetUserId) {
      storedMap.set(id, { deviceId: id, chip: 'ESP32', connected: true });
    }
  }

  res.json({ devices: Array.from(storedMap.values()) });
}));

router.get('/api/agents/status', asyncRoute(async (req, res) => {
  const targetUserId = await resolveUserId(req);
  const status = await getAgentStatus(targetUserId);
  res.json(status);
}));

export default router;
