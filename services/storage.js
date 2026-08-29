import { MongoClient } from 'mongodb';
import dns from 'node:dns';

const memDevices = new Map();
const memJobs = new Map();
const memAgents = new Map();
const memPreferences = new Map(); // userId -> { webCompanion: boolean }

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
      db.collection('preferences').createIndex({ userId: 1 }, { unique: true }),
      db.collection('oauth_sessions').createIndex({ sessionId: 1 }, { unique: true }),
      db.collection('oauth_sessions').createIndex({ createdAt: 1 }, { expireAfterSeconds: 1800 }),
      db.collection('oauth_codes').createIndex({ code: 1 }, { unique: true }),
      db.collection('oauth_codes').createIndex({ createdAt: 1 }, { expireAfterSeconds: 600 }),
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

export async function getAgentStatus(userId) {
  const uid = userId ? String(userId) : null;

  // Collect all in-memory sessions for this user
  const memSessions = [];
  if (uid) {
    for (const [k, v] of memAgents.entries()) {
      if (k.startsWith(`${uid}::`)) memSessions.push(v);
    }
  }

  // If we have any connected session in memory, return aggregate
  if (memSessions.length > 0) {
    const connected = memSessions.some((s) => s.connected);
    const clients = memSessions.filter((s) => s.connected).map((s) => s.clientName);
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
        const connected = docs.some((d) => d.connected);
        const clients = docs.filter((d) => d.connected).map((d) => d.clientName);
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
