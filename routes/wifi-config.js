import { Router } from 'express';
import { resolveUserId } from '../services/user-resolver.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { clearWifiConfig, getWifiConfig, publicWifiConfig, setWifiConfig } from '../services/wifi-config.js';

const router = Router();

router.get('/api/wifi-config', asyncRoute(async (req, res) => {
  const userId = await resolveUserId(req);
  return res.json(publicWifiConfig(getWifiConfig(userId)));
}));

router.patch('/api/wifi-config', asyncRoute(async (req, res) => {
  const userId = await resolveUserId(req);
  const config = setWifiConfig(userId, req.body || {});
  return res.json({ ok: true, ...publicWifiConfig(config) });
}));

router.delete('/api/wifi-config', asyncRoute(async (req, res) => {
  const userId = await resolveUserId(req);
  clearWifiConfig(userId);
  return res.json({ ok: true, mode: 'disabled' });
}));

export default router;
