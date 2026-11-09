import { Router } from 'express';
import { listPlatforms } from '../services/platforms.js';
import { asyncRoute } from '../middleware/errorHandler.js';

const router = Router();

/**
 * Hardware platform registry: every chip family with its vendor, support
 * status, flashing package, and board slugs. The dashboard renders the
 * platform cards and picks the right flashing package from this.
 */


export default router;
