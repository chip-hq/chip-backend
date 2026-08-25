import { MongoClient } from 'mongodb';
import dns from 'node:dns';

const memDevices = new Map();
const memJobs = new Map();
const memAgents = new Map();

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

    await Promise.all([
      db.collection('jobs').createIndex({ jobId: 1 }, { unique: true }),
      db.collection('jobs').createIndex({ userId: 1, createdAt: -1 }),
      db.collection('devices').createIndex({ deviceId: 1 }, { unique: true }),
      db.collection('devices').createIndex({ userId: 1, deviceId: 1 }),
      db.collection('agents').createIndex({ userId: 1 }, { unique: true }),
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

export function upsertDevice({ deviceId, chip, connected = true, userId = null }) {
  const now = new Date();
  const existing = memDevices.get(deviceId);
  const resolvedUserId = userId || existing?.userId || null;
  const doc = {
    deviceId,
    userId: resolvedUserId,
    chip: chip ?? existing?.chip ?? 'ESP32',
    connected,
    firstSeen: existing?.firstSeen ?? now,
    lastSeen: now,
  };
  memDevices.set(deviceId, doc);

  if (canUseMongo()) {
    const updateFields = { chip: doc.chip, connected, lastSeen: now };
    if (resolvedUserId) updateFields.userId = resolvedUserId;

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
  { status, progress, error, logLine, phase, binBase64, binSize, offset, filename, sourceCode, webCompanion } = {}
) {
  const job = memJobs.get(jobId);
  if (!job) return;

  if (phase !== undefined) job.phase = phase;
  if (status !== undefined) job.status = status;
  if (progress !== undefined) job.progress = progress;
  if (error !== undefined) job.error = error;
  if (binBase64 !== undefined) job.binBase64 = binBase64;
  if (binSize !== undefined) job.binSize = binSize;
  if (offset !== undefined) job.offset = offset;
  if (filename !== undefined) job.filename = filename;
  if (sourceCode !== undefined) job.sourceCode = sourceCode;
  if (webCompanion !== undefined) job.webCompanion = webCompanion;
  if (logLine) job.log.push(logLine);
  job.updatedAt = new Date();

  mirrorJob(jobId);
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

// ── Agents / MCP Connections ────────────────────────────────────────────────

export function recordAgentConnection({ userId, clientName = 'Claude', email = null }) {
  if (!userId) return;
  const now = new Date();
  const doc = {
    userId: String(userId),
    clientName,
    email,
    connected: true,
    lastActive: now,
  };
  memAgents.set(String(userId), doc);

  if (canUseMongo()) {
    db.collection('agents')
      .updateOne(
        { userId: String(userId) },
        { $set: doc, $setOnInsert: { firstConnected: now } },
        { upsert: true }
      )
      .catch((err) => warn('recordAgentConnection', err));
  }
  return doc;
}

export async function getAgentStatus(userId) {
  if (userId) {
    const mem = memAgents.get(String(userId));
    if (mem) return mem;
  }

  if (memAgents.size > 0) {
    const first = memAgents.values().next().value;
    if (first) return first;
  }

  if (canUseMongo()) {
    try {
      const query = userId ? { $or: [{ userId: String(userId) }, { email: String(userId) }] } : {};
      const doc = await db.collection('agents').findOne(query, SAFE);
      if (doc) {
        if (userId) memAgents.set(String(userId), doc);
        return doc;
      }
      const anyAgent = await db.collection('agents').findOne({}, SAFE);
      if (anyAgent) return anyAgent;
    } catch (err) {
      warn('getAgentStatus', err);
    }
  }
  return { connected: false };
}
