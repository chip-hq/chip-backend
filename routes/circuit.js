import { Router } from 'express';
import { rm } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import {
  checkCircuitEnvironment,
  testPartLoad,
  buildLedCircuit,
  generateProjectCircuit,
  generateProjectCircuitFromDefinition,
  searchKiCadSymbols,
  getComponentDetails,
} from '../circuit/index.js';
import { handleCircuitChat, SUPPORTED_MODELS } from '../circuit/ai-circuit-agent.js';
import { getDb, isDbConnected, listAgentChats, saveAgentChat, deleteAgentChat } from '../services/storage.js';

const router = Router();

// ── Helpers ──────────────────────────────────────────────────────────────────

function getUserId(req) {
  return req?.userId || req?.user?.id || req?.headers?.['x-user-id'] || req?.query?.userId || req?.body?.userId || 'default_user';
}

/**
 * Get the current circuit version number for a project from MongoDB.
 * Returns 0 if no circuit exists yet.
 */
async function getCurrentVersion(projectId, userId) {
  if (!isDbConnected()) return 0;
  const db = getDb();
  const doc = await db.collection('circuit_versions')
    .findOne({ projectId, userId }, { sort: { version: -1 }, projection: { version: 1 } })
    .catch(() => null);
  return doc?.version ?? 0;
}

/**
 * Get a specific circuit version document from MongoDB.
 */
async function getVersionDoc(projectId, version, userId) {
  if (!isDbConnected()) return null;
  const db = getDb();
  return db.collection('circuit_versions')
    .findOne({ projectId, userId, version })
    .catch(() => null);
}

/**
 * Save a circuit version document to MongoDB.
 */
async function saveVersionDoc(doc) {
  if (!isDbConnected()) return false;
  const db = getDb();
  await db.collection('circuit_versions')
    .replaceOne(
      { projectId: doc.projectId, userId: doc.userId, version: doc.version },
      doc,
      { upsert: true }
    );
  return true;
}

function nodeRef(node) {
  return String(node || '').split('.')[0]?.toUpperCase() || '';
}

function nodePin(node) {
  return String(node || '').split('.')[1]?.toUpperCase() || '';
}

function isSwitchRef(ref) {
  return ref.startsWith('SW') || ref.startsWith('BTN');
}

function isPowerNet(net) {
  const upper = String(net || '').toUpperCase();
  return ['VCC', '3V3', '5V', 'VDD', 'POWER'].some((token) => upper.includes(token));
}

function isTestNet(net) {
  return String(net || '').toUpperCase().includes('TEST');
}

function isSensorSignalNet(net) {
  const upper = String(net || '').toUpperCase();
  return ['SMOKE', 'SENSE', 'ALARM'].some((token) => upper.includes(token));
}

function validateSwitchAndTestWiring(definition) {
  const errors = [];
  const connections = definition.connections || [];

  connections.forEach((conn) => {
    const net = conn.net || '';
    const nodes = conn.nodes || [];
    const switchNodes = nodes.filter((node) => isSwitchRef(nodeRef(node)));

    if (switchNodes.length > 0 && isPowerNet(net)) {
      errors.push(`Unsafe switch wiring: ${net} connects to ${switchNodes.join(', ')}. SW1/BTN inputs must not be tied directly to a power rail.`);
    }

    if (switchNodes.length > 0 && isSensorSignalNet(net) && !isTestNet(net)) {
      errors.push(`Unsafe switch wiring: ${net} connects to ${switchNodes.join(', ')}. Sensor signal nets must stay isolated from the test switch.`);
    }

    if (isTestNet(net)) {
      const sensorTestNodes = nodes.filter((node) => {
        const ref = nodeRef(node);
        const pin = nodePin(node);
        return (ref.startsWith('J') || ref.startsWith('P')) && ['4', 'TEST', 'NC', 'TEST/NC'].includes(pin);
      });

      if (sensorTestNodes.length > 0) {
        errors.push(`Unsafe TEST_IN wiring: ${sensorTestNodes.join(', ')} is on ${net}. Smoke sensor pin 4 TEST/NC must not be tied into the MCU test button loop.`);
      }
    }
  });

  return errors;
}

function splitRef(ref) {
  const match = String(ref || '').trim().match(/^([A-Za-z]+)(\d+)$/);
  return match ? { prefix: match[1].toUpperCase(), number: Number(match[2]) } : null;
}

function normalizeDuplicateRefs(definition) {
  const components = definition.components || [];
  const usedRefs = new Set();
  const renamedRefs = [];
  const maxByPrefix = new Map();

  components.forEach((comp) => {
    const parsed = splitRef(comp.ref);
    if (parsed) {
      maxByPrefix.set(parsed.prefix, Math.max(maxByPrefix.get(parsed.prefix) || 0, parsed.number));
    }
  });

  const normalizedComponents = components.map((comp) => {
    const originalRef = String(comp.ref || '').trim();
    const originalUpper = originalRef.toUpperCase();

    if (!usedRefs.has(originalUpper)) {
      usedRefs.add(originalUpper);
      return comp;
    }

    const parsed = splitRef(originalRef);
    const prefix = parsed?.prefix || 'U';
    let nextNumber = (maxByPrefix.get(prefix) || 0) + 1;
    let nextRef = `${prefix}${nextNumber}`;

    while (usedRefs.has(nextRef.toUpperCase())) {
      nextNumber += 1;
      nextRef = `${prefix}${nextNumber}`;
    }

    maxByPrefix.set(prefix, nextNumber);
    usedRefs.add(nextRef.toUpperCase());
    renamedRefs.push({ from: originalUpper, to: nextRef });

    return { ...comp, ref: nextRef };
  });

  if (renamedRefs.length === 0) return definition;

  const normalizedConnections = (definition.connections || []).map((conn) => ({
    ...conn,
    nodes: (conn.nodes || []).map((node) => {
      const parts = String(node || '').split('.');
      if (parts.length < 2) return node;
      const renamed = renamedRefs.find((ref) => ref.from === parts[0].toUpperCase());
      if (!renamed) return node;

      const netName = String(conn.net || '').toUpperCase();
      const isTransistorSide = netName.includes('BASE') ||
        netName.includes('DRIVE') ||
        (conn.nodes || []).some((n) => nodeRef(n).startsWith('Q'));

      return isTransistorSide ? `${renamed.to}.${parts.slice(1).join('.')}` : node;
    }),
  }));

  return {
    ...definition,
    components: normalizedComponents,
    connections: normalizedConnections,
  };
}

// ── Status & Testing Endpoints ───────────────────────────────────────────────

/**
 * GET /api/circuit/status
 */
router.get('/api/circuit/status', async (req, res, next) => {
  try {
    const status = await checkCircuitEnvironment();
    res.json(status);
  } catch (err) { next(err); }
});

/**
 * GET /api/circuit/test
 */
router.get('/api/circuit/test', async (req, res, next) => {
  try {
    const lib  = String(req.query.lib  || 'R');
    const part = String(req.query.part || 'R');
    const result = await testPartLoad(lib, part);
    const ok = Boolean(result.success || result.componentLoaded);
    res.status(ok ? 200 : 500).json({
      status: ok ? 'ok' : 'error',
      lib,
      part,
      componentLoaded: ok,
      pinCount: result.pinCount || result.pins?.length || 0,
      pins: result.pins || [],
      error: result.error || null,
    });
  } catch (err) { next(err); }
});

/**
 * POST /api/circuit/test-led-circuit
 */
router.post('/api/circuit/test-led-circuit', async (req, res, next) => {
  try {
    const result = await buildLedCircuit();
    res.status(result.success ? 200 : 500).json(result);
  } catch (err) { next(err); }
});

/**
 * POST /api/circuit/led
 */
router.post('/api/circuit/led', async (req, res, next) => {
  try {
    const result = await buildLedCircuit();
    res.status(result.success ? 200 : 500).json(result);
  } catch (err) { next(err); }
});

// ── Library Tools Endpoints ──────────────────────────────────────────────────

/**
 * GET /api/circuit/libraries/search
 */
router.get('/api/circuit/libraries/search', async (req, res, next) => {
  try {
    const query = String(req.query.q || req.query.query || '');
    const results = await searchKiCadSymbols(query);
    res.json(results);
  } catch (err) { next(err); }
});

/**
 * GET /api/circuit/libraries/component
 */
router.get('/api/circuit/libraries/component', async (req, res, next) => {
  try {
    const lib  = String(req.query.lib  || 'R');
    const part = String(req.query.part || 'R');
    const details = await getComponentDetails(lib, part);
    res.status(details.success ? 200 : 404).json(details);
  } catch (err) { next(err); }
});

/**
 * GET /api/circuit/libraries/pins
 */
router.get('/api/circuit/libraries/pins', async (req, res, next) => {
  try {
    const lib  = String(req.query.lib  || 'R');
    const part = String(req.query.part || 'R');
    const details = await getComponentDetails(lib, part);
    if (!details.success) {
      return res.status(404).json({ error: true, message: details.error });
    }
    res.json({ library: lib, part, pinCount: details.pinCount, pins: details.pins });
  } catch (err) { next(err); }
});

// ── Project Endpoints ────────────────────────────────────────────────────────

/**
 * GET /api/circuit/chats
 * List recent Agent Studio chats for the authenticated user and project.
 */
router.get('/api/circuit/chats', async (req, res, next) => {
  try {
    const projectId = String(req.query.projectId || '').trim();
    if (!projectId) return res.status(400).json({ error: 'ProjectId is required.' });

    const chats = await listAgentChats(getUserId(req), projectId);
    res.json({ chats });
  } catch (err) { next(err); }
});

/**
 * POST /api/circuit/chats
 * Create or update an Agent Studio chat transcript.
 */
router.post('/api/circuit/chats', async (req, res, next) => {
  try {
    const { projectId, chatId, title, messages } = req.body || {};
    if (!projectId || typeof projectId !== 'string') {
      return res.status(400).json({ error: 'ProjectId is required.' });
    }
    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: 'Messages must be an array.' });
    }

    const cleanMessages = messages.slice(-200).map((message) => ({
      id: String(message?.id || randomUUID()),
      role: message?.role === 'user' ? 'user' : 'assistant',
      content: String(message?.content || '').slice(0, 12000),
      actions: Array.isArray(message?.actions) ? message.actions.slice(0, 20) : [],
      timestamp: message?.timestamp || new Date().toISOString(),
    }));
    const cleanTitle = String(title || cleanMessages.find((message) => message.role === 'user')?.content || 'New Chat')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'New Chat';
    const chat = await saveAgentChat({
      chatId: typeof chatId === 'string' && chatId ? chatId : randomUUID(),
      projectId: projectId.trim(),
      userId: getUserId(req),
      title: cleanTitle,
      messages: cleanMessages,
    });
    res.status(chatId ? 200 : 201).json({ success: true, chat });
  } catch (err) { next(err); }
});

/**
 * DELETE /api/circuit/chats/:chatId
 * Delete one Agent Studio chat owned by the authenticated user.
 */
router.delete('/api/circuit/chats/:chatId', async (req, res, next) => {
  try {
    await deleteAgentChat(req.params.chatId, getUserId(req));
    res.json({ success: true });
  } catch (err) { next(err); }
});

/**
 * GET /api/projects
 * List all projects for the authenticated user from MongoDB only.
 */
router.get('/api/projects', async (req, res, next) => {
  try {
    const uid = getUserId(req);

    if (!isDbConnected()) {
      return res.json({ count: 0, projects: [] });
    }

    const db = getDb();
    const dbProjects = await db.collection('projects')
      .find(uid !== 'default_user' ? { userId: uid } : {})
      .sort({ updatedAt: -1 })
      .toArray()
      .catch(() => []);

    // Enrich each project with its current circuit version from circuit_versions
    const projects = await Promise.all(dbProjects.map(async (p) => {
      const pid = p.id || p.projectId;
      const curVer = await getCurrentVersion(pid, uid);
      return {
        projectId: pid,
        name: p.name || pid,
        description: p.description || '',
        mcu: p.mcu || 'ESP32-WROOM-32',
        currentVersion: curVer,
        hasCircuit: curVer > 0,
        updatedAt: p.updatedAt || null,
      };
    }));

    res.json({ count: projects.length, projects });
  } catch (err) { next(err); }
});

/**
 * POST /api/projects
 * Create a new project in MongoDB only. No filesystem writes.
 */
router.post('/api/projects', async (req, res, next) => {
  try {
    const { name, description = '', mcu = 'ESP32-WROOM-32' } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Project name is required.' });
    }

    const uid = getUserId(req);
    const cleanSlug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const projectId = cleanSlug
      ? `${cleanSlug}-${Date.now().toString(36).slice(-4)}`
      : `project-${Date.now().toString(36)}`;

    const now = new Date().toISOString();
    const projectDoc = {
      id: projectId,
      projectId,
      name: name.trim(),
      description: description.trim(),
      mcu,
      userId: uid,
      createdAt: now,
      updatedAt: now,
    };

    if (isDbConnected()) {
      const db = getDb();
      await db.collection('projects')
        .replaceOne({ id: projectId }, projectDoc, { upsert: true })
        .catch((err) => console.warn('[circuit] Project DB persist failed:', err.message));
    }

    res.status(201).json({ success: true, project: projectDoc });
  } catch (err) { next(err); }
});

/**
 * GET /api/projects/:projectId
 * Get project metadata.
 */
router.get('/api/projects/:projectId', async (req, res, next) => {
  try {
    const { projectId } = req.params;
    if (!projectId || !/^[a-zA-Z0-9_-]+$/.test(projectId)) {
      return res.status(400).json({ error: 'Invalid projectId.' });
    }

    const uid = getUserId(req);

    let dbProject = null;
    if (isDbConnected()) {
      const db = getDb();
      const ownerFilter = uid !== 'default_user' ? { userId: uid } : {};
      dbProject = await db.collection('projects')
        .findOne({ ...ownerFilter, $or: [{ id: projectId }, { projectId }] })
        .catch(() => null);
    }

    const curVer = await getCurrentVersion(projectId, uid);

    res.json({
      projectId,
      name: dbProject?.name || projectId,
      description: dbProject?.description || '',
      mcu: dbProject?.mcu || 'ESP32-WROOM-32',
      exists: !!dbProject,
      currentVersion: curVer,
      hasCircuit: curVer > 0,
      updatedAt: dbProject?.updatedAt || null,
    });
  } catch (err) { next(err); }
});

/**
 * DELETE /api/projects
 * Delete all projects and all circuit versions for the user from MongoDB.
 */
router.delete('/api/projects', async (req, res, next) => {
  try {
    const uid = getUserId(req);

    if (isDbConnected()) {
      const db = getDb();
      const filter = uid !== 'default_user' ? { userId: uid } : {};

      const userProjects = await db.collection('projects')
        .find(filter, { projection: { id: 1, projectId: 1 } })
        .toArray()
        .catch(() => []);
      const projectIds = userProjects.map((p) => p.id || p.projectId).filter(Boolean);

      const versionFilter = projectIds.length > 0
        ? { projectId: { $in: projectIds } }
        : (uid !== 'default_user' ? { userId: uid } : {});

      await Promise.all([
        db.collection('projects').deleteMany(filter),
        db.collection('circuit_versions').deleteMany(versionFilter),
        db.collection('circuits').deleteMany(versionFilter),
      ]);
    }

    res.json({ success: true, message: 'All projects deleted.' });
  } catch (err) { next(err); }
});

/**
 * DELETE /api/projects/:projectId
 * Delete a project and all its circuit versions from MongoDB.
 */
router.delete('/api/projects/:projectId', async (req, res, next) => {
  try {
    const { projectId } = req.params;
    if (!projectId || !/^[a-zA-Z0-9_-]+$/.test(projectId)) {
      return res.status(400).json({ error: 'Invalid projectId.' });
    }

    const uid = getUserId(req);

    if (isDbConnected()) {
      const db = getDb();
      const ownerFilter = uid !== 'default_user' ? { userId: uid } : {};
      await Promise.all([
        db.collection('projects').deleteMany({ ...ownerFilter, $or: [{ id: projectId }, { projectId }] }),
        db.collection('circuit_versions').deleteMany({ projectId, ...ownerFilter }),
        db.collection('circuits').deleteMany({ projectId, ...ownerFilter }),
      ]);
    }

    res.json({ success: true, projectId, message: `Project ${projectId} deleted.` });
  } catch (err) { next(err); }
});

// ── Circuit Generation & Management Endpoints ────────────────────────────────

/**
 * POST /api/projects/:projectId/circuit/generate
 * Generate a new circuit version. Stores all data in MongoDB; temp files are cleaned up.
 */
router.post('/api/projects/:projectId/circuit/generate', async (req, res, next) => {
  try {
    const { projectId } = req.params;
    if (!projectId || !/^[a-zA-Z0-9_-]+$/.test(projectId)) {
      return res.status(400).json({ error: 'Invalid projectId.' });
    }

    const uid = getUserId(req);
    const { resistorValue = '220' } = req.body || {};

    // 1. Determine next version
    const curVer = await getCurrentVersion(projectId, uid);
    const nextVersion = curVer + 1;

    // 2. Generate to os.tmpdir() (Python SKiDL script writes there)
    const { tmpdir } = await import('os');
    const outDir = join(tmpdir(), `chip-${projectId}-v${nextVersion}-${Date.now()}`);

    const result = await generateProjectCircuit({
      projectId,
      outDir,
      version: nextVersion,
      resistorValue: String(resistorValue),
    });

    if (!result.success) {
      // Clean up temp dir if it exists
      await rm(outDir, { recursive: true, force: true }).catch(() => {});
      return res.status(500).json(result);
    }

    // 3. Read artifact files from temp dir into memory
    const { readdir, readFile } = await import('fs/promises');
    const { existsSync } = await import('fs');

    const artifacts = {};
    if (existsSync(outDir)) {
      const files = await readdir(outDir).catch(() => []);
      for (const f of files) {
        try {
          artifacts[f] = await readFile(join(outDir, f), 'utf-8');
        } catch {
          // skip unreadable files
        }
      }
    }

    // 4. Save circuit version to MongoDB
    const now = new Date().toISOString();
    const versionDoc = {
      projectId,
      userId: uid,
      version: nextVersion,
      isCurrent: true,
      generatedAt: result.generatedAt || now,
      definition: {
        circuitName: result.circuitName || `${projectId} Circuit`,
        projectId,
        version: nextVersion,
        components: result.components || [],
        connections: result.connections || [],
        ercErrors: result.ercErrors || [],
        ercWarnings: result.ercWarnings || [],
      },
      artifacts,
      meta: {
        componentCount: result.components?.length ?? 0,
        connectionCount: result.connections?.length ?? 0,
        ercErrorCount: result.ercErrors?.length ?? 0,
        ercWarningCount: result.ercWarnings?.length ?? 0,
      },
    };

    if (isDbConnected()) {
      const db = getDb();
      // Mark all previous versions as not current
      await db.collection('circuit_versions')
        .updateMany({ projectId, userId: uid }, { $set: { isCurrent: false } })
        .catch(() => {});
      await saveVersionDoc(versionDoc);

      // Update project updatedAt
      await db.collection('projects')
        .updateOne({ id: projectId }, { $set: { updatedAt: now } })
        .catch(() => {});
    }

    // 5. Clean up temp files
    await rm(outDir, { recursive: true, force: true }).catch(() => {});

    res.status(200).json({
      projectId,
      version: nextVersion,
      currentVersion: nextVersion,
      success: true,
      components: result.components || [],
      connections: result.connections || [],
      ercErrors: result.ercErrors || [],
      ercWarnings: result.ercWarnings || [],
      artifacts: Object.keys(artifacts),
      generatedAt: now,
    });
  } catch (err) { next(err); }
});

/**
 * GET /api/projects/:projectId/automation & GET /api/projects/:projectId/circuit
 * Get the current active automation definition from MongoDB.
 */
router.get(['/api/projects/:projectId/automation', '/api/projects/:projectId/circuit'], async (req, res, next) => {
  try {
    const { projectId } = req.params;
    if (!projectId || !/^[a-zA-Z0-9_-]+$/.test(projectId)) {
      return res.status(400).json({ error: 'Invalid projectId.' });
    }

    const uid = getUserId(req);

    if (!isDbConnected()) {
      return res.status(503).json({ error: 'Database not connected.' });
    }

    const db = getDb();
    const doc = await db.collection('circuit_versions')
      .findOne({ projectId, userId: uid, isCurrent: true })
      .catch(() => null);

    if (!doc) {
      return res.status(404).json({
        projectId,
        error: 'No automation versions found for this project.',
      });
    }

    res.json({
      projectId,
      currentVersion: doc.version,
      manifest: doc.meta,
      definition: doc.definition,
      artifacts: Object.keys(doc.artifacts || {}),
    });
  } catch (err) { next(err); }
});

/**
 * GET /api/projects/:projectId/automation/versions & GET /api/projects/:projectId/circuit/versions
 * List all automation versions from MongoDB.
 */
router.get(['/api/projects/:projectId/automation/versions', '/api/projects/:projectId/circuit/versions'], async (req, res, next) => {
  try {
    const { projectId } = req.params;
    if (!projectId || !/^[a-zA-Z0-9_-]+$/.test(projectId)) {
      return res.status(400).json({ error: 'Invalid projectId.' });
    }

    const uid = getUserId(req);

    if (!isDbConnected()) {
      return res.json({ projectId, currentVersion: 0, count: 0, versions: [] });
    }

    const db = getDb();
    const docs = await db.collection('circuit_versions')
      .find({ projectId, userId: uid })
      .sort({ version: 1 })
      .toArray()
      .catch(() => []);

    const curVer = docs.find((d) => d.isCurrent)?.version ?? (docs[docs.length - 1]?.version ?? 0);

    const versions = docs.map((d) => ({
      version: d.version,
      versionTag: `v${d.version}`,
      isCurrent: d.isCurrent,
      createdAt: d.generatedAt || null,
      circuitName: d.definition?.circuitName || null,
      componentCount: d.meta?.componentCount ?? 0,
      connectionCount: d.meta?.connectionCount ?? 0,
      ercErrorCount: d.meta?.ercErrorCount ?? 0,
      ercWarningCount: d.meta?.ercWarningCount ?? 0,
    }));

    res.json({
      projectId,
      currentVersion: curVer,
      count: versions.length,
      versions,
    });
  } catch (err) { next(err); }
});

/**
 * GET /api/projects/:projectId/circuit/versions/:version
 * Get a specific circuit version from MongoDB.
 */
router.get('/api/projects/:projectId/circuit/versions/:version', async (req, res, next) => {
  try {
    const { projectId, version } = req.params;
    if (!projectId || !/^[a-zA-Z0-9_-]+$/.test(projectId)) {
      return res.status(400).json({ error: 'Invalid projectId.' });
    }

    const versionNum = parseInt(String(version).replace(/^v/i, ''), 10);
    if (isNaN(versionNum) || versionNum < 1) {
      return res.status(400).json({ error: 'Invalid version identifier.' });
    }

    const uid = getUserId(req);
    const doc = await getVersionDoc(projectId, versionNum, uid);

    if (!doc) {
      return res.status(404).json({
        projectId,
        version: versionNum,
        error: `Version v${versionNum} not found for project ${projectId}.`,
      });
    }

    res.json({
      projectId,
      version: versionNum,
      versionTag: `v${versionNum}`,
      isCurrent: doc.isCurrent,
      manifest: doc.meta,
      definition: doc.definition,
      artifacts: Object.keys(doc.artifacts || {}),
    });
  } catch (err) { next(err); }
});

/**
 * GET /api/projects/:projectId/circuit/components
 */
router.get('/api/projects/:projectId/circuit/components', async (req, res, next) => {
  try {
    const { projectId } = req.params;
    const uid = getUserId(req);
    const curVer = await getCurrentVersion(projectId, uid);
    if (!curVer) {
      return res.status(404).json({ error: 'No active circuit found for this project.' });
    }

    const doc = await getVersionDoc(projectId, curVer, uid);
    res.json({
      projectId,
      version: curVer,
      components: doc?.definition?.components || [],
    });
  } catch (err) { next(err); }
});

/**
 * GET /api/projects/:projectId/circuit/connections
 */
router.get('/api/projects/:projectId/circuit/connections', async (req, res, next) => {
  try {
    const { projectId } = req.params;
    const uid = getUserId(req);
    const curVer = await getCurrentVersion(projectId, uid);
    if (!curVer) {
      return res.status(404).json({ error: 'No active circuit found for this project.' });
    }

    const doc = await getVersionDoc(projectId, curVer, uid);
    res.json({
      projectId,
      version: curVer,
      connections: doc?.definition?.connections || [],
    });
  } catch (err) { next(err); }
});

/**
 * POST /api/projects/:projectId/circuit/validate
 */
router.post('/api/projects/:projectId/circuit/validate', async (req, res, next) => {
  try {
    const { projectId } = req.params;
    const uid = getUserId(req);
    const curVer = await getCurrentVersion(projectId, uid);
    if (!curVer) {
      return res.status(404).json({ error: 'No active circuit found for validation.' });
    }

    const doc = await getVersionDoc(projectId, curVer, uid);
    const ercErrors = doc?.definition?.ercErrors || [];
    const ercWarnings = doc?.definition?.ercWarnings || [];

    res.json({
      projectId,
      version: curVer,
      valid: ercErrors.length === 0,
      ercErrors,
      ercWarnings,
    });
  } catch (err) { next(err); }
});

// ── Artifact Endpoints ───────────────────────────────────────────────────────

/**
 * GET /api/projects/:projectId/circuit/artifacts
 */
router.get('/api/projects/:projectId/circuit/artifacts', async (req, res, next) => {
  try {
    const { projectId } = req.params;
    const uid = getUserId(req);
    const versionQuery = req.query.version;
    const curVer = await getCurrentVersion(projectId, uid);
    const versionNum = versionQuery ? parseInt(String(versionQuery).replace(/^v/i, ''), 10) : curVer;

    if (!versionNum) {
      return res.status(404).json({ error: 'No circuit versions found.' });
    }

    const doc = await getVersionDoc(projectId, versionNum, uid);
    if (!doc) {
      return res.status(404).json({ error: `Version v${versionNum} not found.` });
    }

    const artifacts = Object.keys(doc.artifacts || {}).map((name) => ({
      name,
      relativePath: `versions/v${versionNum}/${name}`,
      url: `/api/projects/${projectId}/circuit/artifacts/${name}?version=${versionNum}`,
    }));

    res.json({ projectId, version: versionNum, count: artifacts.length, artifacts });
  } catch (err) { next(err); }
});

/**
 * GET /api/projects/:projectId/circuit/artifacts/:artifactName
 */
router.get('/api/projects/:projectId/circuit/artifacts/:artifactName', async (req, res, next) => {
  try {
    const { projectId, artifactName } = req.params;
    const uid = getUserId(req);
    const versionQuery = req.query.version;
    const curVer = await getCurrentVersion(projectId, uid);
    const versionNum = versionQuery ? parseInt(String(versionQuery).replace(/^v/i, ''), 10) : curVer;

    const doc = await getVersionDoc(projectId, versionNum, uid);
    const content = doc?.artifacts?.[artifactName];

    if (content === undefined || content === null) {
      return res.status(404).json({ error: `Artifact ${artifactName} not found.` });
    }

    if (artifactName.endsWith('.json')) {
      try { res.json(JSON.parse(content)); } catch { res.type('text/plain').send(content); }
    } else {
      res.type('text/plain').send(content);
    }
  } catch (err) { next(err); }
});

// ── Incremental Circuit Editing Endpoints ────────────────────────────────────

async function getActiveDefinition(projectId, uid) {
  const curVer = await getCurrentVersion(projectId, uid);
  if (curVer > 0) {
    const doc = await getVersionDoc(projectId, curVer, uid);
    if (doc?.definition) {
      return { currentVersion: curVer, definition: { ...doc.definition } };
    }
  }

  // Baseline for a fresh project
  return {
    currentVersion: 0,
    definition: {
      circuitName: `${projectId} Circuit`,
      projectId,
      version: 0,
      components: [],
      connections: [],
      ercErrors: [],
      ercWarnings: [],
    },
  };
}

async function compileAndSaveNewVersion(projectId, uid, nextVersion, definition) {
  const { tmpdir } = await import('os');
  const { writeFile, readdir, readFile, rm } = await import('fs/promises');
  const { existsSync } = await import('fs');
  const normalizedDefinition = normalizeDuplicateRefs(definition);

  const outDir = join(tmpdir(), `chip-${projectId}-v${nextVersion}-${Date.now()}`);
  const tempDefPath = join(outDir, 'circuit_definition.json');

  // Write definition to temp dir for Python to consume
  const { mkdir } = await import('fs/promises');
  await mkdir(outDir, { recursive: true });
  await writeFile(tempDefPath, JSON.stringify(normalizedDefinition, null, 2), 'utf-8');

  const result = await generateProjectCircuitFromDefinition({
    projectId,
    outDir,
    version: nextVersion,
    definitionPath: tempDefPath,
  });

  // Read artifacts from temp dir
  const artifacts = {};
  if (existsSync(outDir)) {
    const files = await readdir(outDir).catch(() => []);
    for (const f of files) {
      try { artifacts[f] = await readFile(join(outDir, f), 'utf-8'); } catch {}
    }
  }

  const now = new Date().toISOString();
  const versionDoc = {
    projectId,
    userId: uid,
    version: nextVersion,
    isCurrent: true,
    generatedAt: result.generatedAt || now,
    definition: {
      ...normalizedDefinition,
      version: nextVersion,
      ercErrors: result.ercErrors || [],
      ercWarnings: result.ercWarnings || [],
    },
    artifacts,
    meta: {
      componentCount: normalizedDefinition.components?.length ?? 0,
      connectionCount: normalizedDefinition.connections?.length ?? 0,
      ercErrorCount: result.ercErrors?.length ?? 0,
      ercWarningCount: result.ercWarnings?.length ?? 0,
    },
  };

  if (isDbConnected()) {
    const db = getDb();
    await db.collection('circuit_versions')
      .updateMany({ projectId, userId: uid }, { $set: { isCurrent: false } })
      .catch(() => {});
    await saveVersionDoc(versionDoc);
    await db.collection('projects')
      .updateOne({ id: projectId }, { $set: { updatedAt: now } })
      .catch(() => {});
  }

  // Clean up temp files
  await rm(outDir, { recursive: true, force: true }).catch(() => {});

  return { ...result, success: result.success ?? true };
}

/**
 * POST /api/projects/:projectId/circuit/components
 */
router.post('/api/projects/:projectId/circuit/components', async (req, res, next) => {
  try {
    const { projectId } = req.params;
    const uid = getUserId(req);
    const { ref, lib, part, name, value } = req.body;
    if (!ref) return res.status(400).json({ error: 'Missing required parameter: ref' });

    const { currentVersion, definition } = await getActiveDefinition(projectId, uid);

    const newComp = {
      ref: ref.trim(),
      name: (name || part || lib || ref).trim(),
      lib:  (lib  || part || name || ref).trim(),
      value: value ? String(value).trim() : (part || name || ref).trim(),
    };

    const existingIndex = (definition.components || []).findIndex(
      (c) => c.ref.toUpperCase() === ref.trim().toUpperCase()
    );

    if (existingIndex >= 0) {
      definition.components[existingIndex] = newComp;
    } else {
      definition.components = [...(definition.components || []), newComp];
    }

    const nextVersion = (currentVersion || 0) + 1;
    definition.version = nextVersion;

    const result = await compileAndSaveNewVersion(projectId, uid, nextVersion, definition);
    res.json({ success: result.success, version: nextVersion, component: newComp });
  } catch (err) { next(err); }
});

/**
 * DELETE /api/projects/:projectId/circuit/components/:ref
 */
router.delete('/api/projects/:projectId/circuit/components/:ref', async (req, res, next) => {
  try {
    const { projectId, ref } = req.params;
    const uid = getUserId(req);
    const { currentVersion, definition } = await getActiveDefinition(projectId, uid);

    const refUpper = ref.toUpperCase();
    const before = (definition.components || []).length;
    definition.components = (definition.components || []).filter((c) => c.ref.toUpperCase() !== refUpper);

    if (definition.components.length === before) {
      return res.status(404).json({ error: `Component '${ref}' not found.` });
    }

    definition.connections = (definition.connections || [])
      .map((conn) => ({ ...conn, nodes: (conn.nodes || []).filter((n) => !n.toUpperCase().startsWith(`${refUpper}.`)) }))
      .filter((conn) => conn.nodes.length > 0);

    const nextVersion = (currentVersion || 0) + 1;
    definition.version = nextVersion;

    const result = await compileAndSaveNewVersion(projectId, uid, nextVersion, definition);
    res.json({ success: result.success, version: nextVersion, removedRef: ref });
  } catch (err) { next(err); }
});

/**
 * PATCH /api/projects/:projectId/circuit/components/:ref
 */
router.patch('/api/projects/:projectId/circuit/components/:ref', async (req, res, next) => {
  try {
    const { projectId, ref } = req.params;
    const uid = getUserId(req);
    const { value, name } = req.body;
    const { currentVersion, definition } = await getActiveDefinition(projectId, uid);

    const comp = (definition.components || []).find((c) => c.ref.toUpperCase() === ref.toUpperCase());
    if (!comp) return res.status(404).json({ error: `Component '${ref}' not found.` });

    if (value !== undefined) comp.value = String(value).trim();
    if (name  !== undefined) comp.name  = String(name).trim();

    const nextVersion = (currentVersion || 0) + 1;
    definition.version = nextVersion;

    const result = await compileAndSaveNewVersion(projectId, uid, nextVersion, definition);
    res.json({ success: result.success, version: nextVersion, component: comp });
  } catch (err) { next(err); }
});

/**
 * POST /api/projects/:projectId/circuit/connections
 */
router.post('/api/projects/:projectId/circuit/connections', async (req, res, next) => {
  try {
    const { projectId } = req.params;
    const uid = getUserId(req);
    const { net, fromNode, toNode, nodes } = req.body;

    const netName = (net || 'NET').trim();
    const nodesToAdd = [];
    if (fromNode) nodesToAdd.push(fromNode.trim());
    if (toNode) nodesToAdd.push(toNode.trim());
    if (Array.isArray(nodes)) nodes.forEach((n) => { if (n && !nodesToAdd.includes(n.trim())) nodesToAdd.push(n.trim()); });

    if (nodesToAdd.length === 0) return res.status(400).json({ error: 'Missing nodes to connect.' });

    const { currentVersion, definition } = await getActiveDefinition(projectId, uid);
    definition.connections = definition.connections || [];

    let existingNet = definition.connections.find((c) => c.net.toUpperCase() === netName.toUpperCase());
    if (existingNet) {
      nodesToAdd.forEach((n) => { if (!existingNet.nodes.includes(n)) existingNet.nodes.push(n); });
    } else {
      definition.connections.push({ net: netName, nodes: nodesToAdd });
    }

    const wiringErrors = validateSwitchAndTestWiring(definition);
    if (wiringErrors.length > 0) {
      return res.status(400).json({ error: wiringErrors[0], errors: wiringErrors });
    }

    const nextVersion = (currentVersion || 0) + 1;
    definition.version = nextVersion;

    const result = await compileAndSaveNewVersion(projectId, uid, nextVersion, definition);
    res.json({ success: result.success, version: nextVersion, connections: definition.connections });
  } catch (err) { next(err); }
});

/**
 * POST /api/projects/:projectId/circuit/connections/disconnect
 */
router.post('/api/projects/:projectId/circuit/connections/disconnect', async (req, res, next) => {
  try {
    const { projectId } = req.params;
    const uid = getUserId(req);
    const { net, node } = req.body;

    const { currentVersion, definition } = await getActiveDefinition(projectId, uid);
    definition.connections = definition.connections || [];

    if (net && !node) {
      definition.connections = definition.connections.filter((c) => c.net.toUpperCase() !== net.toUpperCase());
    } else if (node) {
      definition.connections = definition.connections
        .map((c) => {
          if (!net || c.net.toUpperCase() === net.toUpperCase()) {
            return { ...c, nodes: c.nodes.filter((n) => n.toUpperCase() !== node.toUpperCase()) };
          }
          return c;
        })
        .filter((c) => c.nodes.length > 0);
    }

    const nextVersion = (currentVersion || 0) + 1;
    definition.version = nextVersion;

    const result = await compileAndSaveNewVersion(projectId, uid, nextVersion, definition);
    res.json({ success: result.success, version: nextVersion, connections: definition.connections });
  } catch (err) { next(err); }
});

/**
 * GET /api/automation/models & GET /api/circuit/models
 * List supported Featherless models for automation studio.
 */
router.get(['/api/automation/models', '/api/circuit/models'], (req, res) => {
  res.json({ models: SUPPORTED_MODELS });
});

/**
 * POST /api/automation/chat & POST /api/circuit/chat
 * AI automation chat endpoint powered by Featherless.
 */
router.post(['/api/automation/chat', '/api/circuit/chat'], async (req, res, next) => {
  try {
    const uid = getUserId(req);
    const { projectId, message, history, model } = req.body || {};

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'Message is required.' });
    }

    if (!projectId) {
      return res.status(400).json({ error: 'ProjectId is required.' });
    }

    const result = await handleCircuitChat({
      projectId,
      userId: uid,
      message: message.trim(),
      history: Array.isArray(history) ? history : [],
      model,
    });

    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[AI Automation Chat Error]:', err);
    res.status(err.status || 500).json({
      error: err.message || 'Failed to process AI automation chat request.',
    });
  }
});

export default router;
