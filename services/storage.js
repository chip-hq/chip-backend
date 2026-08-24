// services/storage.js — Persistence layer for Chip backend.

import { MongoClient } from 'mongodb';
import dns from 'node:dns';

// Live working set. Holds plain metadata/job docs only — never a WebSocket.
const memDevices = new Map(); // deviceId -> device doc
const memJobs = new Map(); // jobId    -> job doc

let client = null;
let db = null;
let mongoReady = false;

function warn(context, err) {
  console.warn(`[storage] ${context}: ${err?.message ?? err}`);
}

function canUseMongo() {
  return !!db && mongoReady;
}

// --- Lifecycle ---------------------------------------------------------------

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
      console.log(`[storage] Using DNS servers: ${servers.join(', ')}`);
    }
  }

  try {
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });

    client.on('serverHeartbeatSucceeded', () => {
      mongoReady = true;
    });
    client.on('serverHeartbeatFailed', () => {
      mongoReady = false;
    });
    client.on('close', () => {
      mongoReady = false;
    });

    db = client.db(dbName);

    await client.connect();
    await db.command({ ping: 1 });
    await Promise.all([
      db.collection('jobs').createIndex({ jobId: 1 }, { unique: true }),
      db.collection('jobs').createIndex({ userId: 1, createdAt: -1 }),
      db.collection('devices').createIndex({ deviceId: 1 }, { unique: true }),
      db.collection('devices').createIndex({ userId: 1, deviceId: 1 }),
    ]);

    mongoReady = true;
    console.log(`[storage] MongoDB connected (db: ${dbName})`);
    return { connected: true };
  } catch (err) {
    mongoReady = false;
    console.warn(
      `[storage] MongoDB unavailable — using in-memory store only: ${err?.message ?? err}`
    );
    return { connected: false };
  }
}

export function isDbConnected() {
  return mongoReady;
}

export async function closeStorage() {
  if (!client) return;
  try {
    await client.close();
  } catch (err) {
    warn('closeStorage', err);
  }
}

// --- Devices -----------------------------------------------------------------

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
    if (resolvedUserId) {
      updateFields.userId = resolvedUserId;
    }
    db.collection('devices')
      .updateOne(
        { deviceId },
        {
          $set: updateFields,
          $setOnInsert: { deviceId, firstSeen: doc.firstSeen },
        },
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
  const query = userId ? { userId } : {};
  if (canUseMongo()) {
    try {
      return await db.collection('devices').find(query, { projection: { _id: 0 } }).toArray();
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
      return await db.collection('devices').findOne({ deviceId }, { projection: { _id: 0 } });
    } catch (err) {
      warn('getDevice', err);
    }
  }
  return null;
}

// --- Jobs --------------------------------------------------------------------

const jobWriteChains = new Map(); // jobId -> Promise

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
      return await db.collection('jobs').findOne({ jobId }, { projection: { _id: 0 } });
    } catch (err) {
      warn('getJob', err);
    }
  }
  return null;
}

export function updateJob(jobId, { status, progress, error, logLine, phase, binBase64, binSize, offset, filename, sourceCode } = {}) {
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
  if (logLine) job.log.push(logLine);
  job.updatedAt = new Date();

  mirrorJob(jobId);
}

export async function listJobs(userId = null) {
  const query = userId ? { userId } : {};
  if (canUseMongo()) {
    try {
      return await db.collection('jobs')
        .find(query, { projection: { _id: 0 } })
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
      if (job.userId === userId) {
        memJobs.delete(id);
      }
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
