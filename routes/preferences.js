import { Router } from 'express';
import { setPreference, getPreference } from '../services/storage.js';
import { asyncRoute } from '../middleware/errorHandler.js';

const router = Router();

// GET /api/preferences — return all preferences for this user
router.get('/api/preferences', asyncRoute(async (req, res) => {
  const userId = req.userId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const webCompanion = await getPreference(userId, 'webCompanion', false);
  return res.json({ webCompanion });
}));

// PATCH /api/preferences — update one or more preferences
router.patch('/api/preferences', asyncRoute(async (req, res) => {
  const userId = req.userId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const { webCompanion } = req.body || {};

  if (typeof webCompanion === 'boolean') {
    await setPreference(userId, 'webCompanion', webCompanion);
    console.log(`[PREFS] User ${userId}: webCompanion = ${webCompanion}`);
  }

  return res.json({ ok: true, webCompanion: typeof webCompanion === 'boolean' ? webCompanion : undefined });
}));

export default router;
