import { Router } from 'express';
import { listJobs, getJob, clearJobs, updateJob } from '../services/storage.js';
import { resolveUserId } from '../services/user-resolver.js';
import { asyncRoute } from '../middleware/errorHandler.js';

const router = Router();

// Heavy blobs (firmware binaries, sources, companions, per-rev text) must
// never ride the polled list/status endpoints — a single .bin is ~1MB base64
// and polling it every few seconds is what made the dashboard feel slow.
// Binaries stay on GET /:jobId/download, source on /:jobId/code.
const HEAVY_FIELDS = ['binBase64', 'sourceCode', 'webCompanion'];
function stripHeavy(job, { keepLog = true, logCap = 120 } = {}) {
  const { revisions, ...rest } = job ?? {};
  const out = { ...rest };
  for (const k of HEAVY_FIELDS) delete out[k];
  if (Array.isArray(revisions)) out.revCount = revisions.length;
  if (Array.isArray(out.log)) {
    out.log = keepLog ? out.log.slice(-logCap) : [];
    if (!keepLog) delete out.log;
  }
  return out;
}

router.get('/api/jobs', asyncRoute(async (req, res) => {
  const targetUserId = await resolveUserId(req);
  const jobs = await listJobs(targetUserId === 'anonymous' ? null : targetUserId);
  res.json({ jobs: jobs.map((j) => stripHeavy(j, { keepLog: false })) });
}));

router.get('/api/jobs/:jobId', asyncRoute(async (req, res) => {
  const { jobId } = req.params;
  const job = await getJob(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  // Full document only on explicit request (detail pages) — polling stays slim.
  if (req.query.full === '1') return res.json(job);
  res.json(stripHeavy(job));
}));

router.patch('/api/jobs/:jobId/status', asyncRoute(async (req, res) => {
  const { jobId } = req.params;
  const { status, progress, error } = req.body || {};
  const job = await getJob(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  updateJob(jobId, {
    status: status || job.status,
    progress: typeof progress === 'number' ? progress : job.progress,
    error: error !== undefined ? error : job.error,
    logLine: status === 'done' ? 'Flashing completed successfully' : undefined,
  });

  res.json({ ok: true, jobId, status: status || job.status, progress });
}));

router.get('/api/jobs/:jobId/download', asyncRoute(async (req, res) => {
  const { jobId } = req.params;
  const job = await getJob(jobId);
  if (!job || !job.binBase64) {
    return res.status(404).json({ error: 'Binary file not found for this job' });
  }
  const buffer = Buffer.from(job.binBase64, 'base64');
  res.setHeader('Content-Type', 'application/octet-stream');
  const safeFilename = (job.filename || `${jobId}.bin`).replace(/[^\w.\-]/g, '_');
  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
  res.send(buffer);
}));

const handleClearJobs = asyncRoute(async (req, res) => {
  const targetUserId = await resolveUserId(req);
  await clearJobs(targetUserId === 'anonymous' ? null : targetUserId);
  res.json({ status: 'ok', message: 'Job history cleared' });
});

router.delete('/api/jobs', handleClearJobs);
router.post('/api/jobs/clear', handleClearJobs);

export default router;
