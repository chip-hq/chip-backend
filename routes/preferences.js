import { Router } from 'express';
import { setPreference, getPreference } from '../services/storage.js';
import { resolveUserId } from '../services/user-resolver.js';
import { asyncRoute } from '../middleware/errorHandler.js';

const router = Router();

// GET /api/preferences — return all preferences for this user
router.get('/api/preferences', asyncRoute(async (req, res) => {
  const userId = await resolveUserId(req);
  const webCompanion = await getPreference(userId, 'webCompanion', true);
  return res.json({ webCompanion });
}));

// PATCH /api/preferences — update one or more preferences
router.patch('/api/preferences', asyncRoute(async (req, res) => {
  const userId = await resolveUserId(req);
  const { webCompanion } = req.body || {};

  if (typeof webCompanion === 'boolean') {
    await setPreference(userId, 'webCompanion', webCompanion);
    // Also update anonymous/global fallback
    await setPreference('anonymous', 'webCompanion', webCompanion);
    console.log(`[PREFS] User ${userId}: webCompanion = ${webCompanion}`);
  }

  return res.json({ ok: true, webCompanion: typeof webCompanion === 'boolean' ? webCompanion : undefined });
}));

export default router;
