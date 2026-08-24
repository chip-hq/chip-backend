// routes/devices.js — Device listing and discovery endpoints.

import { Router } from 'express';
import { listDevices } from '../services/storage.js';
import { deviceSockets } from '../services/websocket.js';
import { resolveUserId } from '../services/user-resolver.js';

const router = Router();

// List known browser devices (used by MCP list_devices or frontend).
router.get('/api/devices', async (req, res) => {
  const targetUserId = req.userId || req.query.userId || null;
  const stored = await listDevices(targetUserId);
  const storedMap = new Map(stored.map((d) => [d.deviceId, d]));

  // Ensure every active WebSocket connection is included with connected: true
  for (const [id] of deviceSockets.entries()) {
    if (storedMap.has(id)) {
      storedMap.get(id).connected = true;
    } else if (!targetUserId) {
      storedMap.set(id, { deviceId: id, chip: 'ESP32', connected: true });
    }
  }

  res.json({ devices: Array.from(storedMap.values()) });
});

export default router;
