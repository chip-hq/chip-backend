// routes/jobs.js — Job management, status, binary downloads, and history clearing.

import { Router } from 'express';
import { listJobs, getJob, clearJobs } from '../services/storage.js';
import { resolveUserId } from '../services/user-resolver.js';
import { asyncRoute } from '../middleware/errorHandler.js';

const router = Router();

// List jobs — try/catch handled by asyncRoute; errors go to central handler.
router.get('/api/jobs', asyncRoute(async (req, res) => {
  const targetUserId = await resolveUserId(req);
  const jobs = await listJobs(targetUserId === 'anonymous' ? null : targetUserId);
  res.json({ jobs });
}));

// Get single job status
router.get('/api/jobs/:jobId', asyncRoute(async (req, res) => {
  const { jobId } = req.params; // parameterized — never concatenated into a query string
  const job = await getJob(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
}));

// Download compiled binary
router.get('/api/jobs/:jobId/download', asyncRoute(async (req, res) => {
  const { jobId } = req.params;
  const job = await getJob(jobId);
  if (!job || !job.binBase64) {
    return res.status(404).json({ error: 'Binary file not found for this job' });
  }
  const buffer = Buffer.from(job.binBase64, 'base64');
  res.setHeader('Content-Type', 'application/octet-stream');
  // Sanitize filename to prevent header injection — strip non-safe characters.
  const safeFilename = (job.filename || `${jobId}.bin`).replace(/[^\w.\-]/g, '_');
  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
  res.send(buffer);
}));

// Clear all jobs (supports both DELETE and POST for proxy compatibility)
const handleClearJobs = asyncRoute(async (req, res) => {
  const targetUserId = await resolveUserId(req);
  await clearJobs(targetUserId === 'anonymous' ? null : targetUserId);
  res.json({ status: 'ok', message: 'Job history cleared' });
});

router.delete('/api/jobs', handleClearJobs);
router.post('/api/jobs/clear', handleClearJobs);

export default router;
