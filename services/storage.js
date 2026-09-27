import { MongoClient } from 'mongodb';
import dns from 'node:dns';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const memDevices = new Map();
const memJobs = new Map();
const memAgents = new Map();
const memPreferences = new Map(); // userId -> { webCompanion: boolean }
const memAgentChats = new Map();


let client = null;
let db = null;
let mongoReady = false;

function warn(context, err) {
  console.warn(`[storage] ${context}: ${err?.message ?? String(err)}`);
}

function canUseMongo() {
  return !!db && mongoReady;
}

const SAFE = { projection: { _id: 0 } };

export async function initStorage() {
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB || 'chip';

  if (!uri) {
    console.warn('[storage] MONGODB_URI not set — using in-memory store only.');
    return { connected: false };
  }

  const dnsServers = process.env.MONGODB_DNS_SERVERS;
  if (dnsServers) {
    const servers = dnsServers.split(',').map((s) => s.trim()).filter(Boolean);
    if (servers.length) {
      dns.setServers(servers);
    }
  }

  const ssl = process.env.MONGODB_SSL !== 'false';
  const clientOptions = {
    minPoolSize: parseInt(process.env.MONGODB_MIN_POOL ?? '2', 10),
    maxPoolSize: parseInt(process.env.MONGODB_MAX_POOL ?? '20', 10),
    maxIdleTimeMS: parseInt(process.env.MONGODB_IDLE_TIMEOUT_MS ?? '30000', 10),
    socketTimeoutMS: parseInt(process.env.MONGODB_SOCKET_TIMEOUT_MS ?? '45000', 10),
    connectTimeoutMS: parseInt(process.env.MONGODB_CONNECT_TIMEOUT_MS ?? '10000', 10),
    serverSelectionTimeoutMS: 8000,
    ...(ssl ? { tls: true } : {}),
    heartbeatFrequencyMS: 10000,
  };

  try {
    client = new MongoClient(uri, clientOptions);

    client.on('serverHeartbeatSucceeded', () => { mongoReady = true; });
    client.on('serverHeartbeatFailed', () => { mongoReady = false; });
    client.on('close', () => { mongoReady = false; });

    db = client.db(dbName);
    await client.connect();
    await db.command({ ping: 1 });

    // Drop legacy unique(userId) BEFORE recreating indexes — it blocked ChatGPT when Claude was already connected
    try {
      await db.collection('agents').dropIndex('userId_1');
    } catch {
      // index may already be gone
    }

    await Promise.all([
      db.collection('jobs').createIndex({ jobId: 1 }, { unique: true }),
      db.collection('jobs').createIndex({ userId: 1, createdAt: -1 }),
      db.collection('devices').createIndex({ deviceId: 1 }, { unique: true }),
      db.collection('devices').createIndex({ userId: 1, deviceId: 1 }),
      // Compound unique: same user can have Claude + ChatGPT connected at once
      db.collection('agents').createIndex({ userId: 1, clientKey: 1 }, { unique: true }),
      db.collection('agents').createIndex({ userId: 1 }),
      db.collection('preferences').createIndex({ userId: 1 }, { unique: true }),
      db.collection('agent_chats').createIndex({ userId: 1, projectId: 1, updatedAt: -1 }),
      db.collection('agent_chats').createIndex({ chatId: 1 }, { unique: true }),
      db.collection('oauth_sessions').createIndex({ sessionId: 1 }, { unique: true }),
      db.collection('oauth_sessions').createIndex({ createdAt: 1 }, { expireAfterSeconds: 1800 }),
      db.collection('oauth_codes').createIndex({ code: 1 }, { unique: true }),
      db.collection('oauth_codes').createIndex({ createdAt: 1 }, { expireAfterSeconds: 600 }),
      // Fleet telemetry: 7-day rolling window, auto-expired by MongoDB.
      db.collection('telemetry').createIndex({ t: 1 }, { expireAfterSeconds: 604800 }),
      db.collection('telemetry').createIndex({ deviceId: 1, t: -1 }),
      db.collection('device_groups').createIndex({ groupId: 1 }, { unique: true }),
      db.collection('device_groups').createIndex({ userId: 1 }),
      db.collection('ota_releases').createIndex({ releaseId: 1 }, { unique: true }),
      db.collection('ota_rollouts').createIndex({ rolloutId: 1 }, { unique: true }),
    ]);

    mongoReady = true;
    console.log(`[storage] MongoDB connected (db: ${dbName})`);
    return { connected: true };
  } catch (err) {
    mongoReady = false;
    warn('initStorage', err);
    return { connected: false };
  }
}

export function getDb() {
  return db;
}

export function isDbConnected() {
  return mongoReady;
}

export async function closeStorage() {
  if (!client) return;
  try {
    await client.close(false);
  } catch (err) {
    warn('closeStorage', err);
  }
}

// ── Devices ──────────────────────────────────────────────────────────────────

export function upsertDevice({ deviceId, chip, connected = true, userId = null, transport = null, firmwareVersion = null, ip = null, token = null, board = null }) {
  const now = new Date();
  const existing = memDevices.get(deviceId);
  const resolvedUserId = userId || existing?.userId || null;
  const doc = {
    deviceId,
    userId: resolvedUserId,
    chip: chip ?? existing?.chip ?? 'ESP32',
    board: board ?? existing?.board ?? null,
    connected,
    transport: transport ?? existing?.transport ?? null,
    firmwareVersion: firmwareVersion ?? existing?.firmwareVersion ?? null,
    ip: ip ?? existing?.ip ?? null,
    token: token ?? existing?.token ?? null,
    tokenCreatedAt: token ? now : (existing?.tokenCreatedAt ?? null),
    firstSeen: existing?.firstSeen ?? now,
    lastSeen: now,
  };
  memDevices.set(deviceId, doc);

  if (canUseMongo()) {
    const updateFields = { chip: doc.chip, connected, lastSeen: now };
    if (resolvedUserId) updateFields.userId = resolvedUserId;
    if (doc.board) updateFields.board = doc.board;
    if (doc.transport) updateFields.transport = doc.transport;
    if (doc.firmwareVersion) updateFields.firmwareVersion = doc.firmwareVersion;
    if (doc.ip) updateFields.ip = doc.ip;
    if (token) {
      updateFields.token = token;
      updateFields.tokenCreatedAt = now;
    }

    db.collection('devices')
      .updateOne(
        { deviceId },
        { $set: updateFields, $setOnInsert: { deviceId, firstSeen: doc.firstSeen } },
        { upsert: true }
      )
      .catch((err) => warn('upsertDevice', err));
  }
  return doc;
}

/**
 * Claim (or reclaim) a board: binds a stable deviceId to a user and issues a
 * device token. The token is baked into firmware (CHIP_DEVICE_TOKEN) and
 * presented by the board on its direct WiFi WebSocket. Re-claiming rotates it.
 */
export async function claimDevice({ deviceId, chip = 'ESP32', userId, board = null }) {
  const cleanId = String(deviceId || '').replace(/[^\w.\-]/g, '_').slice(0, 64) || 'default_device';
  const token = randomBytes(24).toString('hex');
  const doc = upsertDevice({ deviceId: cleanId, chip, connected: false, userId, token, board });

  if (canUseMongo()) {
    try {
      const stored = await db.collection('devices').findOne({ deviceId: cleanId }, SAFE);
      if (stored?.token) return stored;
    } catch (err) { warn('claimDevice', err); }
  }
  return doc;
}

/** Constant-time device-token check for direct board connections. */
export async function verifyDeviceToken(deviceId, token) {
  if (!deviceId || !token) return null;
  const dev = await getDevice(deviceId);
  const expected = dev?.token;
  if (!expected || typeof token !== 'string') return null;
  try {
    const a = Buffer.from(token);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return null;
    if (!timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  return dev;
}

export function setDeviceConnected(deviceId, connected) {
  const now = new Date();
  const existing = memDevices.get(deviceId);
  if (existing) {
    existing.connected = connected;
    existing.lastSeen = now;
  }

  if (canUseMongo()) {
    db.collection('devices')
      .updateOne({ deviceId }, { $set: { connected, lastSeen: now } })
      .catch((err) => warn('setDeviceConnected', err));
  }
}

export async function listDevices(userId = null) {
  const filter = userId ? { userId } : {};
  if (canUseMongo()) {
    try {
      return await db.collection('devices').find(filter, SAFE).toArray();
    } catch (err) {
      warn('listDevices', err);
    }
  }
  const all = Array.from(memDevices.values());
  return userId ? all.filter((d) => d.userId === userId) : all;
}

export async function getDevice(deviceId) {
  const mem = memDevices.get(deviceId);
  if (mem) return mem;

  if (canUseMongo()) {
    try {
      return await db.collection('devices').findOne({ deviceId }, SAFE);
    } catch (err) {
      warn('getDevice', err);
    }
  }
  return null;
}

// ── Jobs ─────────────────────────────────────────────────────────────────────

const jobWriteChains = new Map();

function mirrorJob(jobId) {
  if (!canUseMongo()) return;
  const job = memJobs.get(jobId);
  if (!job) return;

  const snapshot = { ...job, log: [...job.log] };
  const prev = jobWriteChains.get(jobId) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(() => db.collection('jobs').replaceOne({ jobId }, snapshot, { upsert: true }))
    .catch((err) => warn('mirrorJob', err));

  jobWriteChains.set(jobId, next);
  next.finally(() => {
    if (jobWriteChains.get(jobId) === next) jobWriteChains.delete(jobId);
  });
}

export function createJob(job) {
  const now = new Date();
  const doc = {
    ...job,
    userId: job.userId || 'anonymous',
    log: job.log ?? [],
    createdAt: now,
    updatedAt: now,
  };
  memJobs.set(doc.jobId, doc);
  mirrorJob(doc.jobId);
  return doc;
}

export async function getJob(jobId) {
  const mem = memJobs.get(jobId);
  if (mem) return mem;

  if (canUseMongo()) {
    try {
      return await db.collection('jobs').findOne({ jobId }, SAFE);
    } catch (err) {
      warn('getJob', err);
    }
  }
  return null;
}

export function updateJob(
  jobId,
  { status, progress, error, errorCode, logLine, phase, binBase64, binSize, offset, filename, sourceCode, webCompanion, libraries, otaSha256, otaSize, board, platform, artifact, revisions, approved, approvedAt } = {}
) {
  const job = memJobs.get(jobId);
  if (!job) return;

  if (phase !== undefined) job.phase = phase;
  if (status !== undefined) job.status = status;
  if (progress !== undefined) job.progress = progress;
  if (error !== undefined) job.error = error;
  if (errorCode !== undefined) job.errorCode = errorCode;
  if (binBase64 !== undefined) job.binBase64 = binBase64;
  if (binSize !== undefined) job.binSize = binSize;
  if (offset !== undefined) job.offset = offset;
  if (filename !== undefined) job.filename = filename;
  if (sourceCode !== undefined) job.sourceCode = sourceCode;
  if (webCompanion !== undefined) job.webCompanion = webCompanion;
  if (libraries !== undefined) job.libraries = libraries;
  if (otaSha256 !== undefined) job.otaSha256 = otaSha256;
  if (otaSize !== undefined) job.otaSize = otaSize;
  if (board !== undefined) job.board = board;
  if (platform !== undefined) job.platform = platform;
  if (artifact !== undefined) job.artifact = artifact;
  if (revisions !== undefined) job.revisions = revisions;
  if (approved !== undefined) job.approved = approved;
  if (approvedAt !== undefined) job.approvedAt = approvedAt;
  if (logLine) job.log.push(logLine);
  job.updatedAt = new Date();

  mirrorJob(jobId);
}

/**
 * Pull a Mongo-persisted job back into the write-through memory map.
 * Needed after every backend restart: lists read from Mongo, but mutations
 * (revisions, approvals, status) go through memJobs + mirrorJob.
 */
export async function rehydrateJob(jobId) {
  if (memJobs.has(jobId)) return memJobs.get(jobId);
  const stored = await getJob(jobId);
  if (stored) memJobs.set(jobId, stored);
  return stored ?? null;
}

/**
 * Code revisions: every MCP compile writes rev 1 (the generated source);
 * every dashboard IDE save appends a user revision. The diff between revs
 * is what Claude reads to continue from the user's edits.
 */
export async function appendCodeRevision(jobId, { source, author = 'user', summary = null } = {}) {
  const job = await rehydrateJob(jobId);
  if (!job) return null;
  if (typeof source !== 'string' || source.length === 0) {
    throw Object.assign(new Error('"source" (string) is required'), { status: 400 });
  }
  if (source.length > 500_000) {
    throw Object.assign(new Error('Source too large (max 500KB)'), { status: 400 });
  }
  const revisions = Array.isArray(job.revisions) ? [...job.revisions] : [];
  // Legacy builds (compiled before revisions existed) carry only sourceCode.
  // Seed it as rev 1 = Claude's generated code, so the user's first real
  // save becomes rev 2 instead of rewriting history.
  if (revisions.length === 0 && typeof job.sourceCode === 'string' && job.sourceCode.length > 0 && job.sourceCode !== source) {
    revisions.push({
      rev: 1,
      author: 'claude',
      summary: 'Generated code (pre-review-system build)',
      createdAt: job.createdAt ?? new Date(),
      size: job.sourceCode.length,
      source: job.sourceCode,
    });
  }
  const rev = {
    rev: revisions.length + 1,
    author,
    summary,
    createdAt: new Date(),
    size: source.length,
    source,
  };
  revisions.push(rev);
  job.revisions = revisions;
  job.sourceCode = source;
  job.updatedAt = new Date();
  mirrorJob(jobId);
  const { source: _omit, ...meta } = rev;
  return meta;
}

/**
 * Delete one revision. Refuses when it's the only one left (a job always
 * keeps at least one revision). Deleting the newest rev falls the live
 * source back to the previous revision. Numbers are never reused.
 */
export async function deleteCodeRevision(jobId, revNum) {
  const job = await rehydrateJob(jobId);
  if (!job) return null;
  const revisions = Array.isArray(job.revisions) ? [...job.revisions] : [];
  const n = Number(revNum);
  const idx = revisions.findIndex((r) => r.rev === n);
  if (idx === -1) {
    throw Object.assign(new Error(`Revision ${revNum} not found`), { status: 404 });
  }
  if (revisions.length <= 1) {
    throw Object.assign(new Error('Cannot delete the only remaining revision — a job must keep at least one copy of its code'), { status: 400 });
  }
  revisions.splice(idx, 1);
  const latest = Math.max(...revisions.map((r) => r.rev));
  const latestEntry = revisions.find((r) => r.rev === latest);
  job.revisions = revisions;
  job.sourceCode = latestEntry?.source ?? job.sourceCode;
  job.updatedAt = new Date();
  mirrorJob(jobId);
  return { deleted: n, revCount: revisions.length, latestRev: latest };
}
export async function updateDraft(jobId, source) {
  const job = await rehydrateJob(jobId);
  if (!job) return null;
  if (typeof source !== 'string' || source.length === 0) {
    throw Object.assign(new Error('"source" (string) is required'), { status: 400 });
  }
  if (source.length > 500_000) {
    throw Object.assign(new Error('Source too large (max 500KB)'), { status: 400 });
  }
  job.sourceCode = source;
  job.updatedAt = new Date();
  mirrorJob(jobId);
  return { revCount: Array.isArray(job.revisions) ? job.revisions.length : 0 };
}

export async function listJobs(userId = null) {
  const filter = userId ? { userId } : {};
  if (canUseMongo()) {
    try {
      return await db.collection('jobs')
        .find(filter, SAFE)
        .sort({ createdAt: -1 })
        .toArray();
    } catch (err) {
      warn('listJobs', err);
    }
  }
  const all = Array.from(memJobs.values());
  const filtered = userId ? all.filter((j) => j.userId === userId) : all;
  return filtered.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

export async function clearJobs(userId = null) {
  if (userId) {
    for (const [id, job] of memJobs.entries()) {
      if (job.userId === userId) memJobs.delete(id);
    }
  } else {
    memJobs.clear();
  }

  if (canUseMongo()) {
    try {
      const filter = userId ? { userId } : {};
      await db.collection('jobs').deleteMany(filter);
    } catch (err) {
      warn('clearJobs', err);
    }
  }
}

// ── Agent Chats ──────────────────────────────────────────────────────────────

export async function listAgentChats(userId, projectId) {
  const filter = { userId, projectId };
  if (canUseMongo()) {
    try {
      return await db.collection('agent_chats').find(filter, SAFE).sort({ updatedAt: -1 }).limit(50).toArray();
    } catch (err) { warn('listAgentChats', err); }
  }
  return Array.from(memAgentChats.values())
    .filter((chat) => chat.userId === userId && chat.projectId === projectId)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 50);
}

export async function saveAgentChat(chat) {
  const existing = memAgentChats.get(chat.chatId);
  if (existing && existing.userId !== chat.userId) throw new Error('Chat is not owned by this user.');
  const now = new Date();
  const doc = { ...existing, ...chat, createdAt: existing?.createdAt || now, updatedAt: now };
  memAgentChats.set(doc.chatId, doc);
  if (canUseMongo()) await db.collection('agent_chats').replaceOne({ chatId: doc.chatId, userId: doc.userId }, doc, { upsert: true });
  return doc;
}

export async function deleteAgentChat(chatId, userId) {
  const existing = memAgentChats.get(chatId);
  if (existing?.userId === userId) memAgentChats.delete(chatId);
  if (canUseMongo()) await db.collection('agent_chats').deleteOne({ chatId, userId });
}

// ── Agents / MCP Connections ────────────────────────────────────────────────
// Keyed as `${userId}:${clientKey}` where clientKey is a stable identifier for the agent client

function agentMemKey(userId, clientKey) {
  return `${String(userId)}::${String(clientKey || 'default')}`;
}

export function recordAgentConnection({ userId, clientName = 'MCP Agent', email = null, clientKey = null }) {
  if (!userId) return;
  const now = new Date();
  const uid = String(userId);
  // Use first 12 chars of clientName as a stable key if no clientKey provided
  const key = clientKey || clientName.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 12) || 'default';
  const memKey = agentMemKey(uid, key);
  const doc = {
    userId: uid,
    clientName,
    clientKey: key,
    email,
    connected: true,
    lastActive: now,
  };
  memAgents.set(memKey, doc);

  if (canUseMongo()) {
    db.collection('agents')
      .updateOne(
        { userId: uid, clientKey: key },
        { $set: doc, $setOnInsert: { firstConnected: now } },
        { upsert: true }
      )
      .catch((err) => warn('recordAgentConnection', err));
  }
  return doc;
}

export function disconnectAgent(userId, clientKey = null) {
  const now = new Date();
  if (userId) {
    const uid = String(userId);
    if (clientKey) {
      // Disconnect only a specific client
      const key = String(clientKey);
      const memKey = agentMemKey(uid, key);
      memAgents.delete(memKey);
      if (canUseMongo()) {
        db.collection('agents')
          .updateMany(
            { userId: uid, clientKey: key },
            { $set: { connected: false, disconnectedAt: now } }
          )
          .catch((err) => warn('disconnectAgent', err));
      }
    } else {
      // Disconnect all clients for this user
      for (const k of memAgents.keys()) {
        if (k.startsWith(`${uid}::`)) memAgents.delete(k);
      }
      if (canUseMongo()) {
        db.collection('agents')
          .updateMany(
            { userId: uid },
            { $set: { connected: false, disconnectedAt: now } }
          )
          .catch((err) => warn('disconnectAgent', err));
      }
    }
  } else {
    // Global disconnect all
    memAgents.clear();
    if (canUseMongo()) {
      db.collection('agents')
        .updateMany({}, { $set: { connected: false, disconnectedAt: now } })
        .catch((err) => warn('disconnectAgent', err));
    }
  }
}

// A session is considered active if a tool was called within the last 5 minutes.
// Claude and ChatGPT do NOT reliably send revocation requests on disconnect,
// so activity-based expiry is the only practical way to detect silent disconnects.
const AGENT_TTL_MS = 5 * 60 * 1000;

function isSessionActive(session) {
  if (!session || !session.connected) return false;
  if (!session.lastActive) return false;
  return Date.now() - new Date(session.lastActive).getTime() < AGENT_TTL_MS;
}

export async function getAgentStatus(userId) {
  const uid = userId ? String(userId) : null;

  // Collect all in-memory sessions for this user
  const memSessions = [];
  if (uid) {
    for (const [k, v] of memAgents.entries()) {
      if (k.startsWith(`${uid}::`)) memSessions.push(v);
    }
  }

  // If we have sessions in memory, evaluate activity
  if (memSessions.length > 0) {
    const activeSessions = memSessions.filter(isSessionActive);
    const connected = activeSessions.length > 0;
    const clients = activeSessions.map((s) => s.clientName);
    return {
      connected,
      clientName: clients.join(' + ') || memSessions[0].clientName,
      clients,
      userId: uid,
    };
  }

  // Fall back to MongoDB
  if (canUseMongo() && uid) {
    try {
      const docs = await db.collection('agents').find(
        { userId: uid },
        { ...SAFE, limit: 10 }
      ).toArray();
      if (docs.length > 0) {
        // Cache in memory
        for (const doc of docs) {
          memAgents.set(agentMemKey(uid, doc.clientKey || 'default'), doc);
        }
        const activeDocs = docs.filter(isSessionActive);
        const connected = activeDocs.length > 0;
        const clients = activeDocs.map((d) => d.clientName);
        return {
          connected,
          clientName: clients.join(' + ') || docs[0].clientName,
          clients,
          userId: uid,
        };
      }
    } catch (err) {
      warn('getAgentStatus', err);
    }
  }

  return { connected: false };
}

// ── User Preferences ─────────────────────────────────────────────────────────

export async function setPreference(userId, key, value) {
  if (!userId) return;
  const uid = String(userId);
  const current = memPreferences.get(uid) || {};
  const updated = { ...current, [key]: value, userId: uid, updatedAt: new Date() };
  memPreferences.set(uid, updated);

  if (canUseMongo()) {
    try {
      await db.collection('preferences').updateOne(
        { userId: uid },
        { $set: { [key]: value, updatedAt: updated.updatedAt } },
        { upsert: true }
      );
    } catch (err) {
      warn('setPreference', err);
    }
  }
}

export async function getPreference(userId, key, defaultValue = null) {
  if (!userId) return defaultValue;
  const uid = String(userId);

  // Check in-memory first
  const mem = memPreferences.get(uid);
  if (mem && key in mem) return mem[key];

  if (canUseMongo()) {
    try {
      const doc = await db.collection('preferences').findOne({ userId: uid }, SAFE);
      if (doc) {
        memPreferences.set(uid, doc);
        return key in doc ? doc[key] : defaultValue;
      }
    } catch (err) {
      warn('getPreference', err);
    }
  }
  return defaultValue;
}

// ── Fleet: telemetry ─────────────────────────────────────────────────────────
// In-memory ring per device (cap 500) + MongoDB TTL collection (7 days).

const memTelemetry = new Map(); // deviceId -> [{ t, data }]
const TELEMETRY_MEM_CAP = 500;

export function pushTelemetry(deviceId, data) {
  const point = { t: new Date(), data: data ?? {} };
  const ring = memTelemetry.get(deviceId) ?? [];
  ring.push(point);
  if (ring.length > TELEMETRY_MEM_CAP) ring.splice(0, ring.length - TELEMETRY_MEM_CAP);
  memTelemetry.set(deviceId, ring);

  if (canUseMongo()) {
    db.collection('telemetry')
      .insertOne({ deviceId, t: point.t, data: point.data })
      .catch((err) => warn('pushTelemetry', err));
  }
  return point;
}

export async function getTelemetry(deviceId, limit = 100) {
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  const mem = memTelemetry.get(deviceId) ?? [];
  if (mem.length > 0) return mem.slice(-safeLimit).reverse();
  if (canUseMongo()) {
    try {
      return await db.collection('telemetry')
        .find({ deviceId }, SAFE)
        .sort({ t: -1 })
        .limit(safeLimit)
        .toArray();
    } catch (err) { warn('getTelemetry', err); }
  }
  return [];
}

// ── Fleet: device groups ─────────────────────────────────────────────────────

const memGroups = new Map(); // groupId -> doc

function groupDoc(groupId, userId, patch = {}) {
  const now = new Date();
  const existing = memGroups.get(groupId);
  const doc = {
    groupId,
    userId,
    name: patch.name ?? existing?.name ?? 'Untitled group',
    memberIds: Array.isArray(patch.memberIds) ? [...new Set(patch.memberIds.map(String))] : (existing?.memberIds ?? []),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  memGroups.set(groupId, doc);
  if (canUseMongo()) {
    db.collection('device_groups')
      .replaceOne({ groupId }, doc, { upsert: true })
      .catch((err) => warn('groupDoc', err));
  }
  return doc;
}

export async function createGroup(userId, name, memberIds = []) {
  const groupId = `grp_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`;
  return groupDoc(groupId, userId, { name: String(name || 'Untitled group').slice(0, 80), memberIds });
}

export async function listGroups(userId) {
  if (canUseMongo()) {
    try {
      const docs = await db.collection('device_groups').find({ userId }, SAFE).sort({ updatedAt: -1 }).toArray();
      for (const d of docs) memGroups.set(d.groupId, d);
      return docs;
    } catch (err) { warn('listGroups', err); }
  }
  return Array.from(memGroups.values())
    .filter((g) => !userId || g.userId === userId)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

export async function getGroup(groupId) {
  const mem = memGroups.get(groupId);
  if (mem) return mem;
  if (canUseMongo()) {
    try {
      const doc = await db.collection('device_groups').findOne({ groupId }, SAFE);
      if (doc) {
        memGroups.set(groupId, doc);
        return doc;
      }
    } catch (err) { warn('getGroup', err); }
  }
  return null;
}

export async function updateGroupMembers(groupId, userId, { add = [], remove = [] } = {}) {
  const existing = await getGroup(groupId);
  if (!existing || (userId && existing.userId !== userId)) return null;
  const members = new Set(existing.memberIds ?? []);
  for (const id of add) if (typeof id === 'string' && id) members.add(id);
  for (const id of remove) members.delete(id);
  return groupDoc(groupId, existing.userId, { memberIds: [...members] });
}

export async function deleteGroup(groupId, userId) {
  const existing = await getGroup(groupId);
  if (!existing || (userId && existing.userId !== userId)) return false;
  memGroups.delete(groupId);
  if (canUseMongo()) {
    try { await db.collection('device_groups').deleteOne({ groupId }); } catch (err) { warn('deleteGroup', err); }
  }
  return true;
}

// ── Fleet: OTA releases & rollouts ───────────────────────────────────────────

const memReleases = new Map(); // releaseId -> doc
const memRollouts = new Map(); // rolloutId -> doc

function mirrorDoc(collection, keyField, doc) {
  if (!canUseMongo()) return;
  db.collection(collection)
    .replaceOne({ [keyField]: doc[keyField] }, doc, { upsert: true })
    .catch((err) => warn(`mirrorDoc:${collection}`, err));
}

export async function createRelease({ userId, version, target = {}, jobId = null, sha256, size, filename = 'firmware.bin' }) {
  const releaseId = `rel_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`;
  const doc = {
    releaseId,
    userId: userId || 'anonymous',
    version: String(version),
    targetDeviceId: target.deviceId ?? null,
    targetGroupId: target.groupId ?? null,
    jobId,
    sha256,
    size,
    filename,
    createdAt: new Date(),
  };
  memReleases.set(releaseId, doc);
  mirrorDoc('ota_releases', 'releaseId', doc);
  return doc;
}

export async function listReleases(userId, limit = 50) {
  if (canUseMongo()) {
    try {
      return await db.collection('ota_releases')
        .find(userId ? { userId } : {}, SAFE)
        .sort({ createdAt: -1 })
        .limit(Math.max(1, Math.min(200, Number(limit) || 50)))
        .toArray();
    } catch (err) { warn('listReleases', err); }
  }
  const all = Array.from(memReleases.values());
  const filtered = userId ? all.filter((r) => r.userId === userId) : all;
  return filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 50);
}

export async function latestReleaseForDevice(deviceId, userId = null) {
  const [releases, groups] = await Promise.all([
    listReleases(userId, 200),
    userId ? listGroups(userId) : Promise.resolve([]),
  ]);
  const groupIds = new Set(groups.filter((g) => (g.memberIds ?? []).includes(deviceId)).map((g) => g.groupId));
  const match = releases.find((r) =>
    r.targetDeviceId === deviceId || (r.targetGroupId && groupIds.has(r.targetGroupId)));
  return match ?? null;
}

export async function createRollout({ userId, groupId, releaseId, version, memberIds, batchSize = 5 }) {
  const rolloutId = `roll_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`;
  const devices = {};
  for (const id of memberIds) {
    devices[id] = { status: 'queued', updatedAt: new Date(), error: null };
  }
  const doc = {
    rolloutId,
    userId: userId || 'anonymous',
    groupId,
    releaseId,
    version: String(version),
    batchSize: Math.max(1, Math.min(50, Number(batchSize) || 5)),
    state: 'running',
    devices,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  memRollouts.set(rolloutId, doc);
  mirrorDoc('ota_rollouts', 'rolloutId', doc);
  return doc;
}

export async function getRollout(rolloutId) {
  const mem = memRollouts.get(rolloutId);
  if (mem) return mem;
  if (canUseMongo()) {
    try {
      const doc = await db.collection('ota_rollouts').findOne({ rolloutId }, SAFE);
      if (doc) {
        memRollouts.set(rolloutId, doc);
        return doc;
      }
    } catch (err) { warn('getRollout', err); }
  }
  return null;
}

export async function listRollouts(userId, limit = 50) {
  if (canUseMongo()) {
    try {
      return await db.collection('ota_rollouts')
        .find(userId ? { userId } : {}, SAFE)
        .sort({ createdAt: -1 })
        .limit(Math.max(1, Math.min(200, Number(limit) || 50)))
        .toArray();
    } catch (err) { warn('listRollouts', err); }
  }
  const all = Array.from(memRollouts.values());
  const filtered = userId ? all.filter((r) => r.userId === userId) : all;
  return filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 50);
}

export function updateRolloutDoc(doc) {
  doc.updatedAt = new Date();
  memRollouts.set(doc.rolloutId, doc);
  mirrorDoc('ota_rollouts', 'rolloutId', doc);
  return doc;
}

/** Per-device OTA state, mirrored onto the device doc for dashboard reads. */
export function reportOtaStatus(deviceId, { status, version = null, error = null }) {
  const existing = memDevices.get(deviceId);
  const ota = { status, version, error, updatedAt: new Date() };
  if (existing) {
    existing.ota = ota;
    existing.lastSeen = new Date();
    if (version) existing.firmwareVersion = existing.firmwareVersion ?? null;
  }
  if (canUseMongo()) {
    const update = { ota, lastSeen: new Date() };
    db.collection('devices')
      .updateOne({ deviceId }, { $set: update })
      .catch((err) => warn('reportOtaStatus', err));
  }
  return ota;
}
