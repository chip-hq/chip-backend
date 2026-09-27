import { Router } from 'express';
import { writeFile, mkdir, readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { createJob, updateJob, recordAgentConnection, getPreference, getJob, appendCodeRevision } from '../services/storage.js';
import {
  compileFirmware,
  normalizeLibraries,
  inferLibrariesFromSource,
  librariesForComponents,
  mergeLibraries,
  listHardwareComponents,
  resolveBoard,
  compilableBoardSlugs,
  LibraryResolveError,
  LibraryNetworkError,
} from '../services/platformio-runner.js';
import { deviceSockets } from '../services/websocket.js';
import { resolveUserId } from '../services/user-resolver.js';
import { asyncRoute } from '../middleware/errorHandler.js';

const router = Router();

const FIRMWARE_B64_CACHE = join(homedir(), '.chip-build-cache', 'last_firmware.b64');
const ALLOWED_BOARDS = new Set(compilableBoardSlugs());

/** Canonical Chip Agent header (cached): auto-provided when components request it. */
let cachedAgentHeader = null;
async function loadAgentHeader() {
  if (cachedAgentHeader) return cachedAgentHeader;
  const p = join(dirname(fileURLToPath(import.meta.url)), '..', 'firmware', 'chip-agent.h');
  cachedAgentHeader = await readFile(p, 'utf8');
  return cachedAgentHeader;
}

router.get('/api/hardware-components', asyncRoute(async (_req, res) => {
  return res.json({ components: listHardwareComponents() });
}));

router.post('/api/compile/recompile', asyncRoute(async (req, res) => {
  const { jobId: compileJobId, source, board, webCompanion, libraries, libDeps, components } = req.body || {};

  if (!compileJobId || typeof compileJobId !== 'string') {
    return res.status(400).json({ error: '"jobId" is required for recompile' });
  }
  if (!source || typeof source !== 'string' || source.trim().length === 0) {
    return res.status(400).json({ error: '"source" (C++ string) is required' });
  }

  const existingJob = await getJob(compileJobId);
  if (!existingJob) {
    return res.status(404).json({ error: `Job ${compileJobId} not found` });
  }

  const targetBoard = typeof board === 'string' && ALLOWED_BOARDS.has(board.toLowerCase()) ? board.toLowerCase() : existingJob.board || 'esp32';
  const boardInfo = resolveBoard(targetBoard);
   const platformId = (boardInfo?.platform.id) ?? (existingJob.platform || 'esp32');

  let resolvedLibs;
  let componentList = [];
  try {
    componentList = Array.isArray(components) ? components.filter((c) => typeof c === 'string' && c.trim()).map((c) => c.trim()) : [];
    const explicit = normalizeLibraries(libraries ?? libDeps);
    const fromComponents = librariesForComponents(componentList);
    const inferred = inferLibrariesFromSource(source);
    resolvedLibs = mergeLibraries(explicit, [...fromComponents, ...inferred]);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (req.userId) {
    recordAgentConnection({ userId: req.userId, clientName: 'Claude / MCP Agent', email: req.userEmail || null });
  }

  const companionRequired = await getPreference(req.userId, 'webCompanion', false);
  if (companionRequired && (!webCompanion || typeof webCompanion !== 'string' || webCompanion.trim().length === 0)) {
    return res.status(400).json({ error: 'Web Companion required.' });
  }

  const wantsAgent = componentList.some((c) => /chip[-_]?agent/i.test(c));
  const linksAgent = /chip_?agent/i.test(source);
  let agentHeader = null;
  let agentWarning = null;
  if (wantsAgent) {
    try { agentHeader = await loadAgentHeader(); } catch { agentWarning = 'Chip Agent header unavailable.'; }
    if (!linksAgent && !agentWarning) { agentWarning = 'components requested "chip-agent" but the source never references it.'; }
  }

  const prevSource = existingJob.sourceCode ?? '';
  const revCount = existingJob.revisions?.length ?? (prevSource ? 1 : 0);
  appendCodeRevision(compileJobId, { source, author: 'claude', summary: `Recompiled rev ${revCount + 1}` }).catch(() => {});
  updateJob(compileJobId, {
    sourceCode: source, board: targetBoard, platform: platformId,
    libraries: resolvedLibs, components: componentList,
    webCompanion: typeof webCompanion === 'string' ? webCompanion : null,
    status: 'compiling', progress: 0,
    log: ['Recompile job started…'],
  });

  console.log(`[RECOMPILE] Job ${compileJobId} started — board: ${targetBoard}`);

  try {
    const result = await compileFirmware({
      source, board: targetBoard, libraries: resolvedLibs, components: componentList,
      jobId: compileJobId, agentHeader,
      onLog: (line) => { updateJob(compileJobId, { logLine: line }); },
    });

    updateJob(compileJobId, {
      status: 'done', progress: 100,
      binBase64: result.binBase64, binSize: result.binSize,
      offset: result.offset || '0x0', filename: result.filename || `firmware_${targetBoard}.bin`,
      platform: result.platformId || platformId, artifact: result.artifact || 'bin',
      sourceCode: source, libraries: resolvedLibs,
      webCompanion: typeof webCompanion === 'string' ? webCompanion : null,
      logLine: `Done — ${result.binSize} bytes in ${(result.durationMs / 1000).toFixed(1)}s`,
    });

    try { await mkdir(join(homedir(), '.chip-build-cache'), { recursive: true }); await writeFile(FIRMWARE_B64_CACHE, result.binBase64, 'utf8'); } catch {}

    console.log(`[RECOMPILE] Job ${compileJobId} done — ${result.binSize} bytes`);

    return res.json({
      jobId: compileJobId, status: 'done', binBase64: result.binBase64,
      binSize: result.binSize, offset: result.offset || '0x0',
      filename: result.filename || `firmware_${targetBoard}.bin`,
      artifact: result.artifact || 'bin', platform: result.platformId || platformId,
      board: targetBoard, durationMs: result.durationMs, libraries: resolvedLibs,
      log: result.log,
      ...(agentWarning ? { agentWarning } : {}),
    });
  } catch (err) {
    const isLibError = err instanceof LibraryResolveError || err.code === 'LIBRARY_RESOLVE';
    const isNetError = err instanceof LibraryNetworkError || err.code === 'LIBRARY_NETWORK';
    const isOom = err.code === 'COMPILE_OOM';
    const errorCode = isLibError ? 'LIBRARY_RESOLVE' : isNetError ? 'LIBRARY_NETWORK' : isOom ? 'COMPILE_OOM' : 'COMPILE_FAILED';
    const clientError = (isLibError || isNetError || isOom) ? err.message : 'Firmware compilation failed.';
    const status = (isLibError || isNetError || isOom) ? 400 : 500;

    updateJob(compileJobId, { status: 'error', error: err.message, errorCode, logLine: `Error: ${err.message}` });
    console.error(`[RECOMPILE] Job ${compileJobId} failed:`, err.message);

    return res.status(status).json({ jobId: compileJobId, status: 'error', error: clientError, errorCode, log: err.log ?? undefined });
  }
}));

router.post('/api/compile', asyncRoute(async (req, res) => {
  const {
    source,
    board: rawBoard = 'esp32',
    webCompanion,
    libraries,
    libDeps,
    components,
  } = req.body || {};

  if (!source || typeof source !== 'string' || source.trim().length === 0) {
    return res.status(400).json({ error: '"source" (C++ string) is required' });
  }

  const board = typeof rawBoard === 'string' && ALLOWED_BOARDS.has(rawBoard.toLowerCase())
    ? rawBoard.toLowerCase()
    : 'esp32';
  const boardInfo = resolveBoard(board);
  const platformId = boardInfo?.platform.id ?? 'esp32';

  let resolvedLibs;
  let componentList = [];
  try {
    componentList = Array.isArray(components)
      ? components.filter((c) => typeof c === 'string' && c.trim()).map((c) => c.trim())
      : [];
    const explicit = normalizeLibraries(libraries ?? libDeps);
    const fromComponents = librariesForComponents(componentList);
    const inferred = inferLibrariesFromSource(source);
    resolvedLibs = mergeLibraries(explicit, [...fromComponents, ...inferred]);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (req.userId) {
    recordAgentConnection({
      userId: req.userId,
      clientName: 'Claude / MCP Agent',
      email: req.userEmail || null,
    });
  }

  // Check if the user requires a Web Companion from their settings
  const companionRequired = await getPreference(req.userId, 'webCompanion', false);
  if (companionRequired && (!webCompanion || typeof webCompanion !== 'string' || webCompanion.trim().length === 0)) {
    return res.status(400).json({
      error: 'Web Companion required: The user has enabled AI Web Companion in their settings. ' +
             'You MUST include a "webCompanion" field containing a self-contained HTML/CSS/JS string that ' +
             'visually simulates what this firmware does on the ESP32 (e.g. animated ON/OFF indicator for LED blink, ' +
             'live gauge for sensor data, slider controls for PWM). ' +
             'Please retry compile_firmware with the webCompanion field included.',
    });
  }

  const jobId = `compile_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const anyDevice = Array.from(deviceSockets.keys())[0];
  const userId = await resolveUserId(req, anyDevice);

  // Chip Agent linkage: the header is auto-provided, but the sketch itself
  // must include it and pump it — otherwise this build can never go OTA.
  const wantsAgent = componentList.some((c) => /chip[-_]?agent/i.test(c));
  const linksAgent = /chip_?agent/i.test(source);
  let agentHeader = null;
  let agentWarning = null;
  if (wantsAgent) {
    try {
      agentHeader = await loadAgentHeader();
    } catch {
      agentWarning = 'Chip Agent header unavailable on the server; build continues without the realtime/OTA client and cannot be updated OTA.';
    }
    if (!linksAgent && !agentWarning) {
      agentWarning = 'components requested "chip-agent" but the source never references it. Add #include "chip_agent.h" plus chipAgentBegin()/chipAgentLoop() or this build can never receive OTA updates.';
    }
  }

  createJob({
    jobId,
    userId,
    phase: 'compile',
    board,
    platform: platformId,
    sourceCode: source,
    // Rev 1 is the MCP-generated source — the dashboard IDE diffs every
    // user edit against it, and Claude reads the diff to continue.
    revisions: [{ rev: 1, author: 'claude', summary: 'Generated by Claude', createdAt: new Date(), size: source.length, source }],
    approved: false,
    libraries: resolvedLibs,
    components: componentList,
    webCompanion: typeof webCompanion === 'string' ? webCompanion : null,
    filename: `firmware_${board}.bin`,
    status: 'compiling',
    progress: 0,
    log: [
      'Compile job started…',
      ...(componentList.length ? [`Components: ${componentList.join(', ')}`] : []),
      ...(resolvedLibs.length
        ? [`Libraries: ${resolvedLibs.join(', ')}`]
        : ['Libraries: (none — core only)']),
    ],
  });

  console.log(
    `[COMPILE] Job ${jobId} started — board: ${board}` +
    `${webCompanion ? ' (with Web Companion)' : ''}` +
    `${componentList.length ? ` components=[${componentList.join(', ')}]` : ''}` +
    `${resolvedLibs.length ? ` libs=[${resolvedLibs.join(', ')}]` : ''}`,
  );

  try {
    const result = await compileFirmware({
      source,
      board,
      libraries: resolvedLibs,
      components: componentList,
      jobId,
      agentHeader,
      onLog: (line) => {
        updateJob(jobId, { logLine: line });
      },
    });

    updateJob(jobId, {
      status: 'done',
      progress: 100,
      binBase64: result.binBase64,
      binSize: result.binSize,
      offset: result.offset || '0x0',
      filename: result.filename || `firmware_${board}.bin`,
      platform: result.platformId || platformId,
      artifact: result.artifact || 'bin',
      sourceCode: source,
      libraries: resolvedLibs,
      webCompanion: typeof webCompanion === 'string' ? webCompanion : null,
      logLine: `Done — ${result.binSize} bytes in ${(result.durationMs / 1000).toFixed(1)}s`,
    });

    try {
      await mkdir(join(homedir(), '.chip-build-cache'), { recursive: true });
      await writeFile(FIRMWARE_B64_CACHE, result.binBase64, 'utf8');
    } catch {
      // non-fatal cache write
    }

    console.log(`[COMPILE] Job ${jobId} done — ${result.binSize} bytes (@ ${result.offset || '0x0'})`);

    return res.json({
      jobId,
      status: 'done',
      binBase64: result.binBase64,
      binSize: result.binSize,
      offset: result.offset || '0x0',
      filename: result.filename || `firmware_${board}.bin`,
      artifact: result.artifact || 'bin',
      platform: result.platformId || platformId,
      board,
      durationMs: result.durationMs,
      libraries: resolvedLibs,
      log: result.log,
      ...(agentWarning ? { agentWarning } : {}),
    });
  } catch (err) {
    const isLibError = err instanceof LibraryResolveError || err.code === 'LIBRARY_RESOLVE';
    const isNetError = err instanceof LibraryNetworkError || err.code === 'LIBRARY_NETWORK';
    const isOom = err.code === 'COMPILE_OOM';
    const errorCode = isLibError
      ? 'LIBRARY_RESOLVE'
      : isNetError
        ? 'LIBRARY_NETWORK'
        : isOom
          ? 'COMPILE_OOM'
          : 'COMPILE_FAILED';
    const clientError = (isLibError || isNetError || isOom)
      ? err.message
      : 'Firmware compilation failed. Please check your C++ syntax.';
    const status = (isLibError || isNetError || isOom) ? 400 : 500;

    updateJob(jobId, {
      status: 'error',
      error: err.message,
      errorCode,
      logLine: `Error: ${err.message}`,
    });
    console.error(`[COMPILE] Job ${jobId} failed:`, err.message);

    return res.status(status).json({
      jobId,
      status: 'error',
      error: clientError,
      errorCode,
      ...(isLibError && err.unresolved ? { unresolvedLibraries: err.unresolved } : {}),
      log: err.log ?? undefined,
    });
  }
}));

export default router;
