// storage.js — persistence layer for Chip's backend.
//
// Model: the in-memory Maps are the always-available live working set (the flash
// relay must never depend on the DB being up — the browser is "the hand"). Mongo
// is mirrored best-effort on top and preferred for reads, so a restarted process
// can still serve jobs created before the restart.
//
//   write  -> memory (always) + Mongo (best-effort, fire-and-forget)
//   read   -> Mongo first when connected, else fall back to memory
//
// Every Mongo call is wrapped so a DB hiccup can never block a socket message or
// an HTTP response, and initStorage() never throws — the server always boots.

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

  // Escape hatch for machines whose default resolver can't do the SRV lookup a
  // "mongodb+srv://" URI needs (e.g. a node resolver pointed at a dead
  // 127.0.0.1). Opt-in and a no-op if unset — production/Render never needs it.
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

    // Keep mongoReady honest as the topology comes and goes, so /health is
    // accurate and we skip Mongo attempts while it's known-down.
    client.on('serverHeartbeatSucceeded', () => {
      mongoReady = true;
    });
    client.on('serverHeartbeatFailed', () => {
      mongoReady = false;
    });
    client.on('close', () => {
      mongoReady = false;
    });

    // db handle is valid even before connect(); operations connect lazily.
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
  const doc = {
    deviceId,
    userId: userId ?? existing?.userId ?? null,
    chip: chip ?? existing?.chip ?? 'ESP32',
    connected,
    firstSeen: existing?.firstSeen ?? now,
    lastSeen: now,
  };
  memDevices.set(deviceId, doc);

  if (canUseMongo()) {
    db.collection('devices')
      .updateOne(
        { deviceId },
        {
          $set: { chip: doc.chip, connected, lastSeen: now, userId: doc.userId },
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

// --- Jobs --------------------------------------------------------------------

// Per-job serialized Mongo write chain. Memory is the authoritative live copy;
// each mirror writes a full, immutable snapshot of the in-memory doc (never an
// incremental $push). Serializing per job keeps writes in submission order, so
// fire-and-forget mirrors can't reorder or double-append, and every write is
// idempotent — safe to run after a create hasn't landed yet (upsert).
const jobWriteChains = new Map(); // jobId -> Promise

function mirrorJob(jobId) {
  if (!canUseMongo()) return;
  const job = memJobs.get(jobId);
  if (!job) return;

  const snapshot = { ...job, log: [...job.log] };
  const prev = jobWriteChains.get(jobId) ?? Promise.resolve();
  const next = prev
    .catch(() => {}) // a prior failure must not break the chain
    .then(() => db.collection('jobs').replaceOne({ jobId }, snapshot, { upsert: true }))
    .catch((err) => warn('mirrorJob', err));

  jobWriteChains.set(jobId, next);
  next.finally(() => {
    // Drop the chain once it drains, unless a newer write already replaced it.
    if (jobWriteChains.get(jobId) === next) jobWriteChains.delete(jobId);
  });
}

export function createJob(job) {
  const now = new Date();
  const doc = {
    ...job,
    log: job.log ?? [],
    createdAt: now,
    updatedAt: now,
  };
  memJobs.set(doc.jobId, doc);
  mirrorJob(doc.jobId);
  return doc;
}

// Memory-first: during a live session the in-memory doc is always the freshest
// (it's written synchronously before the Mongo mirror). Mongo is the fallback
// that answers after a restart — or on another instance — when memory is empty.
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

// Patch a job's status/progress/error/phase and optionally append one log line.
export function updateJob(jobId, { status, progress, error, logLine, phase } = {}) {
  const job = memJobs.get(jobId);
  if (!job) return; // unknown job — nothing authoritative to update

  if (phase !== undefined) job.phase = phase;
  if (status !== undefined) job.status = status;
  if (progress !== undefined) job.progress = progress;
  if (error !== undefined) job.error = error;
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


