import { Router } from 'express';
import { listPlatforms } from '../services/platforms.js';
import { asyncRoute } from '../middleware/errorHandler.js';

const router = Router();


router.get('/api/platforms', asyncRoute(async (_req, res) => {
  res.json({ count: listPlatforms().length, platforms: listPlatforms() });
}));

export default router;
