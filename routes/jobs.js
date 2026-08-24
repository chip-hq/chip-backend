// routes/jobs.js — Job management, status, binary downloads, and history clearing.

import { Router } from 'express';
import { listJobs, getJob, clearJobs } from '../services/storage.js';
import { resolveUserId } from '../services/user-resolver.js';

const router = Router();

// List jobs (optionally filtered by logged-in user or userId query param)
router.get('/api/jobs', async (req, res) => {
  const targetUserId = await resolveUserId(req);
  const jobs = await listJobs(targetUserId === 'anonymous' ? null : targetUserId);
  res.json({ jobs });
});

// Get job status (used by dashboard and MCP get_status)
router.get('/api/jobs/:jobId', async (req, res) => {
  const job = await getJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  res.json(job);
});

// Download compiled binary directly
router.get('/api/jobs/:jobId/download', async (req, res) => {
  const job = await getJob(req.params.jobId);
  if (!job || !job.binBase64) {
    return res.status(404).json({ error: 'Binary file not found for this job' });
  }
  const buffer = Buffer.from(job.binBase64, 'base64');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${job.filename || `${job.jobId}.bin`}"`);
  res.send(buffer);
});

// Clear all jobs in history (supports both DELETE and POST)
const handleClearJobs = async (req, res) => {
  const targetUserId = await resolveUserId(req);
  await clearJobs(targetUserId === 'anonymous' ? null : targetUserId);
  res.json({ status: 'ok', message: 'Job history cleared' });
};

router.delete('/api/jobs', handleClearJobs);
router.post('/api/jobs/clear', handleClearJobs);

export default router;
