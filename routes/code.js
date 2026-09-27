import { Router } from 'express';
import { getJob, listJobs, updateJob, appendCodeRevision, updateDraft, deleteCodeRevision, rehydrateJob } from '../services/storage.js';
import { diffLines, diffToText } from '../services/diff.js';
import { asyncRoute } from '../middleware/errorHandler.js';

const router = Router();

function revSource(job, revNum) {
  const revs = Array.isArray(job.revisions) ? job.revisions : [];
  if (revNum === 'latest' || revNum == null) {
    return { rev: revs.length, source: job.sourceCode, entry: revs[revs.length - 1] ?? null };
  }
  const n = Number(revNum);
  const entry = revs.find((r) => r.rev === n) ?? null;
  return { rev: n, source: entry?.source ?? null, entry };
}

/**
 * Code review surface for the dashboard IDE + Claude.
 * Every compile seeds rev 1 (Claude's generated source); every IDE save
 * appends a user revision. Diffs are always computed from stored text —
 * single source of truth, no client-side guessing.
 */
router.get('/api/jobs/:jobId/code', asyncRoute(async (req, res) => {
  const job = await getJob(String(req.params.jobId));
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  const { rev, source, entry } = revSource(job, req.query.rev ?? 'latest');
  if (req.query.rev != null && source == null) {
    return res.status(404).json({ error: `Revision ${req.query.rev} not found.` });
  }
  const revs = Array.isArray(job.revisions) ? job.revisions : [];
  res.json({
    jobId: job.jobId,
    board: job.board ?? null,
    platform: job.platform ?? null,
    status: job.status,
    approved: !!job.approved,
    approvedAt: job.approvedAt ?? null,
    revCount: revs.length,
    rev,
    author: entry?.author ?? (rev === 1 ? 'claude' : null),
    summary: entry?.summary ?? null,
    source: source ?? job.sourceCode ?? null,
    revisions: revs.map(({ source: _omit, ...meta }) => meta),
  });
}));

router.post('/api/jobs/:jobId/code', asyncRoute(async (req, res) => {
  const job = await getJob(String(req.params.jobId));
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  // mode 'draft' (default): working save, no new revision.
  // mode 'revision': explicit checkpoint the user chose to create.
  const { source, summary = null, mode = 'draft' } = req.body ?? {};
  const prev = job.sourceCode ?? '';
  let revNum;
  try {
    if (mode === 'revision') {
      const meta = await appendCodeRevision(job.jobId, { source, author: 'user', summary });
      if (!meta) return res.status(404).json({ error: 'Job not found.' });
      revNum = meta.rev;
    } else {
      const out = await updateDraft(job.jobId, source);
      if (!out) return res.status(404).json({ error: 'Job not found.' });
      revNum = out.revCount;
    }
  } catch (err) {
    // Our own validation errors carry an explicit message — surface it.
    if (err && typeof err.status === 'number') {
      return res.status(err.status).json({ error: err.message });
    }
    throw err;
  }
  const d = diffLines(prev, source);
  // Any content change re-opens review — the old approval no longer covers it.
  if (d.added + d.removed > 0) updateJob(job.jobId, { approved: false });
  res.json({ jobId: job.jobId, rev: revNum, mode: mode === 'revision' ? 'revision' : 'draft', added: d.added, removed: d.removed, approved: false });
}));

router.get('/api/jobs/:jobId/diff', asyncRoute(async (req, res) => {
  const job = await getJob(String(req.params.jobId));
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  const revs = Array.isArray(job.revisions) ? job.revisions : [];
  const from = req.query.from ?? '1';
  const to = req.query.to ?? 'latest';
  const a = revSource(job, from);
  const b = revSource(job, to);
  if (a.source == null) return res.status(404).json({ error: `Revision ${from} not found.` });
  if (b.source == null) return res.status(404).json({ error: `Revision ${to} not found.` });
  const d = diffLines(a.source, b.source);
  const MAX_OPS = 2000;
  const truncated = d.ops.length > MAX_OPS;
  const ops = truncated ? d.ops.slice(0, MAX_OPS) : d.ops;
  res.json({
    jobId: job.jobId,
    from: a.rev,
    to: b.rev === (revs.length || 1) && to === 'latest' ? revs.length || 1 : b.rev,
    added: d.added,
    removed: d.removed,
    truncated,
    ops,
    text: diffToText({ ...d, ops }),
  });
}));

router.delete('/api/jobs/:jobId/code/revisions/:rev', asyncRoute(async (req, res) => {
  const job = await getJob(String(req.params.jobId));
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  try {
    const out = await deleteCodeRevision(job.jobId, req.params.rev);
    if (!out) return res.status(404).json({ error: 'Job not found.' });
    res.json({ jobId: job.jobId, ...out });
  } catch (err) {
    if (err && typeof err.status === 'number') {
      return res.status(err.status).json({ error: err.message });
    }
    throw err;
  }
}));

router.post('/api/jobs/:jobId/approve', asyncRoute(async (req, res) => {  const job = await rehydrateJob(String(req.params.jobId));
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  const approved = req.body?.approved !== false;
  updateJob(job.jobId, approved
    ? { approved: true, approvedAt: new Date() }
    : { approved: false });
  res.json({ jobId: job.jobId, approved });
}));

/**
 * Review → flash pipeline for one compile job. The dashboard renders the
 * visual stage flow from `stages`; Claude gets the same state plus a
 * self-contained `cardHtml` it can drop into an Artifact for the user.
 */
router.get('/api/jobs/:jobId/pipeline', asyncRoute(async (req, res) => {
  const job = await getJob(String(req.params.jobId));
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  const revs = Array.isArray(job.revisions) ? job.revisions : [];
  const revCount = revs.length || (job.sourceCode ? 1 : 0);

  let flashes = [];
  try {
    const all = await listJobs(job.userId && job.userId !== 'anonymous' ? job.userId : null, 200);
    flashes = all.filter((j) => j && (j.phase === 'flash' || String(j.jobId || '').startsWith('flash_')) && j.sourceJobId === job.jobId);
  } catch {
    flashes = [];
  }
  const flashDone = flashes.some((f) => f.status === 'done');
  const flashActive = !flashDone && flashes.some((f) => ['started', 'uploading', 'flashing'].includes(f.status));
  const flashError = !flashDone && !flashActive && flashes.some((f) => f.status === 'error');

  const stages = [
    { id: 'generated', label: 'Code generated', state: 'done', detail: `rev 1 by Claude${revCount > 1 ? ` · ${revCount - 1} user edit${revCount > 2 ? 's' : ''}` : ''}` },
    {
      id: 'in_review', label: 'Preview & edit', state: job.approved ? 'done' : revCount > 1 ? 'active' : 'pending',
      detail: job.approved ? 'approved' : revCount > 1 ? `rev ${revCount} waiting for approval` : 'open the Code tab to review rev 1',
    },
    {
      id: 'approved', label: 'Approved', state: job.approved ? 'done' : 'pending',
      detail: job.approved ? `approved${job.approvedAt ? ` ${new Date(job.approvedAt).toLocaleString()}` : ''}` : 'user confirms in the Code tab',
    },
    {
      id: 'compiled', label: 'Compiled', state: job.status === 'done' ? 'done' : job.status === 'error' ? 'error' : 'active',
      detail: job.status === 'done' ? `${job.binSize ?? 0} bytes · ${job.platform ?? job.board ?? ''}` : job.status,
    },
    {
      id: 'flashed', label: 'Flashed', state: flashDone ? 'done' : flashActive ? 'active' : flashError ? 'error' : 'pending',
      detail: flashDone ? 'on the board' : flashActive ? 'writing…' : flashError ? 'flash failed — see job log' : 'after approval',
    },
  ];

  res.json({
    jobId: job.jobId,
    board: job.board ?? null,
    platform: job.platform ?? null,
    artifact: job.artifact ?? null,
    approved: !!job.approved,
    revCount,
    stages,
    cardHtml: pipelineCardHtml(job, stages),
  });
}));

function pipelineCardHtml(job, stages) {
  const dots = { done: '#16a34a', active: '#000000', pending: '#d1d5db', error: '#dc2626' };
  const cards = stages.map((s, i) => `
    <div style="flex:1;min-width:120px;background:#fff;border:1px solid ${s.state === 'active' ? '#000' : '#e5e5e5'};border-radius:6px;padding:10px 12px;">
      <div style="display:flex;align-items:center;gap:6px;">
        <span style="width:8px;height:8px;border-radius:50%;background:${dots[s.state] || '#d1d5db'};"></span>
        <span style="font-size:11px;color:#888;font-weight:600;">STEP ${i + 1}</span>
      </div>
      <div style="font-size:13px;font-weight:700;color:#000;margin-top:4px;">${s.label}</div>
      <div style="font-size:11px;color:#666;margin-top:2px;">${s.detail || ''}</div>
      <div style="font-size:10px;font-weight:700;margin-top:6px;color:${dots[s.state] || '#888'};text-transform:uppercase;">${s.state.replace('_', ' ')}</div>
    </div>${i < stages.length - 1 ? '<div style="align-self:center;color:#d1d5db;font-weight:700;padding:0 2px;">→</div>' : ''}`).join('');
  return `<!DOCTYPE html><html><body style="margin:0;background:#f5f5f5;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;padding:16px;">
<div style="max-width:760px;margin:0 auto;background:#f5f5f5;">
<div style="font-size:14px;font-weight:700;color:#000;">Chip pipeline · <span style="font-family:monospace;">${job.jobId}</span></div>
<div style="font-size:11px;color:#666;margin:2px 0 12px;">${job.board ?? ''}${job.platform ? ' · ' + job.platform : ''} · ${job.approved ? 'approved' : 'awaiting approval'}</div>
<div style="display:flex;align-items:stretch;gap:0;">${cards}</div>
</div></body></html>`;
}

export default router;
