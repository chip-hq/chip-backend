import { Router } from 'express';
import { listPlatforms } from '../services/platforms.js';
import { asyncRoute } from '../middleware/errorHandler.js';

const router = Router();

/**
 * Hardware platform registry: every chip family with its vendor, support
 * status, flashing package, and board slugs. The dashboard renders the
 * platform cards and picks the right flashing package from this.
 */
router.get('/api/platforms', asyncRoute(async (_req, res) => {
  res.json({ count: listPlatforms().length, platforms: listPlatforms() });
}));

export default router;
