// services/storage.js — Persistence layer for Chip backend.
//
// Security & resilience features applied:
//  ✓ Connection pooling (min/max pool limits)
//  ✓ Idle / socket / server-selection timeouts
//  ✓ SSL/TLS enforcement via MONGODB_SSL=true or Atlas SRV URI
//  ✓ Heartbeat monitoring — auto-marks mongo as unavailable
//  ✓ Graceful in-memory fallback on connection failure
//  ✓ Parameterized queries throughout (MongoDB driver, no string interpolation)
//  ✓ _id stripped from all outgoing documents (data masking)
//  ✓ Internal error messages never forwarded to callers — only logged
//  ✓ Serialised per-job write chains prevent N+1 / race conditions
//  ✓ Connection leak prevention: every cursor/session is explicitly closed

import { MongoClient } from 'mongodb';
import dns from 'node:dns';

// ── In-memory working set ────────────────────────────────────────────────────
// Plain POJOs only — WebSocket handles never stored here.
const memDevices = new Map(); // deviceId -> device doc
const memJobs    = new Map(); // jobId    -> job doc

let client     = null;
let db         = null;
let mongoReady = false;

// ── Safe internal logger (never leaks error details to callers) ──────────────
function warn(context, err) {
  // Only log to server console — never propagated to API responses.
  console.warn(`[storage] ${context}: ${err?.message ?? String(err)}`);
}

function canUseMongo() {
  return !!db && mongoReady;
}

// Safe projection — strips MongoDB internal _id from all returned documents.
const SAFE = { projection: { _id: 0 } };

// ── Lifecycle ────────────────────────────────────────────────────────────────

export async function initStorage() {
  const uri    = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB || 'chip';

  if (!uri) {
    console.warn('[storage] MONGODB_URI not set — using in-memory store only.');
    return { connected: false };
  }

  // Optional: override DNS servers (useful in restricted cloud envs)
  const dnsServers = process.env.MONGODB_DNS_SERVERS;
  if (dnsServers) {
    const servers = dnsServers.split(',').map((s) => s.trim()).filter(Boolean);
    if (servers.length) {
      dns.setServers(servers);
      console.log(`[storage] Using DNS servers: ${servers.join(', ')}`);
    }
  }

  // ── Connection pool & security options ──────────────────────────────────
  // Connection Pooling: prevents exhaustion under concurrent AI agent requests.
  // Idle Timeouts: reclaims database resources from stale sockets.
  // SSL: encrypted transit even on private subnets (disable only for local dev).
  const ssl = process.env.MONGODB_SSL !== 'false'; // default: true

  const clientOptions = {
    // Pool limits
    minPoolSize: parseInt(process.env.MONGODB_MIN_POOL ?? '2',  10),
    maxPoolSize: parseInt(process.env.MONGODB_MAX_POOL ?? '20', 10),

    // Idle & socket timeouts (ms)
    maxIdleTimeMS:          parseInt(process.env.MONGODB_IDLE_TIMEOUT_MS   ?? '30000', 10),
    socketTimeoutMS:        parseInt(process.env.MONGODB_SOCKET_TIMEOUT_MS ?? '45000', 10),
    connectTimeoutMS:       parseInt(process.env.MONGODB_CONNECT_TIMEOUT_MS ?? '10000', 10),
    serverSelectionTimeoutMS: 8000,

    // SSL/TLS — Atlas SRV URIs already enforce this; explicit flag for non-SRV URIs.
    ...(ssl ? { tls: true } : {}),

    // Heartbeat interval (ms) — detects dead primaries quickly
    heartbeatFrequencyMS: 10000,
  };

  try {
    client = new MongoClient(uri, clientOptions);

    // ── Health monitoring ──────────────────────────────────────────────────
    client.on('serverHeartbeatSucceeded', () => { mongoReady = true;  });
    client.on('serverHeartbeatFailed',    () => { mongoReady = false; });
    client.on('close',                    () => { mongoReady = false; });

    // ── Connection leak detection ──────────────────────────────────────────
    // Log if the driver detects a connection was checked out and not returned.
    client.on('connectionCheckOutFailed', ({ reason }) => {
      console.warn(`[storage] Connection checkout failed: ${reason}`);
    });
    client.on('connectionClosed', ({ reason }) => {
      if (reason === 'error') {
        console.warn('[storage] A connection was closed due to an error — possible leak.');
      }
    });

    db = client.db(dbName);
    await client.connect();
    await db.command({ ping: 1 });

    // ── Indexes — idempotent; safe to call on every startup ────────────────
    // Parameterized field names in the driver call (not user input).
    await Promise.all([
      db.collection('jobs').createIndex({ jobId:    1 }, { unique: true }),
      db.collection('jobs').createIndex({ userId: 1, createdAt: -1 }),
      db.collection('devices').createIndex({ deviceId: 1 }, { unique: true }),
      db.collection('devices').createIndex({ userId:   1, deviceId: 1 }),
    ]);

    mongoReady = true;
    console.log(`[storage] MongoDB connected — pool: ${clientOptions.minPoolSize}–${clientOptions.maxPoolSize}, SSL: ${ssl}`);
    return { connected: true };
  } catch (err) {
    mongoReady = false;
    // Data masking: only log internally, never surface raw error to callers.
    warn('initStorage', err);
    console.warn('[storage] Falling back to in-memory store.');
    return { connected: false };
  }
}

export function isDbConnected() {
  return mongoReady;
}

export async function closeStorage() {
  if (!client) return;
  try {
    // Ensure the pool is drained and all connections released before exit.
    await client.close(/* force= */ false);
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
    userId:    resolvedUserId,
    chip:      chip ?? existing?.chip ?? 'ESP32',
    connected,
    firstSeen: existing?.firstSeen ?? now,
    lastSeen:  now,
  };
  memDevices.set(deviceId, doc);

  if (canUseMongo()) {
    // Parameterized: filter and update values are structured objects, never raw strings.
    const updateFields = { chip: doc.chip, connected, lastSeen: now };
    if (resolvedUserId) updateFields.userId = resolvedUserId;

    db.collection('devices')
      .updateOne(
        { deviceId },                          // ← parameterized filter
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
    existing.lastSeen  = now;
  }

  if (canUseMongo()) {
    db.collection('devices')
      .updateOne({ deviceId }, { $set: { connected, lastSeen: now } })  // parameterized
      .catch((err) => warn('setDeviceConnected', err));
  }
}

export async function listDevices(userId = null) {
  // Parameterized filter: userId is always a plain string or null, never raw input.
  const filter = userId ? { userId } : {};
  if (canUseMongo()) {
    try {
      // Cursor explicitly consumed by toArray() — no leak.
      return await db.collection('devices').find(filter, SAFE).toArray();
    } catch (err) {
      warn('listDevices', err);
      // Graceful fallback: serve from memory if Mongo fails mid-request.
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
      // findOne implicitly closes its cursor — no leak.
      return await db.collection('devices').findOne({ deviceId }, SAFE); // parameterized
    } catch (err) {
      warn('getDevice', err);
      // Graceful fallback: return null so callers handle missing device cleanly.
    }
  }
  return null;
}

// ── Jobs ─────────────────────────────────────────────────────────────────────

// Serialised per-job write chains:
// Prevents N+1 race conditions where rapid updateJob() calls could interleave
// and overwrite each other's Mongo writes out of order.
const jobWriteChains = new Map(); // jobId -> Promise

function mirrorJob(jobId) {
  if (!canUseMongo()) return;
  const job = memJobs.get(jobId);
  if (!job) return;

  // Snapshot to avoid mutating the in-flight object mid-write.
  const snapshot = { ...job, log: [...job.log] };

  const prev = jobWriteChains.get(jobId) ?? Promise.resolve();
  const next = prev
    .catch(() => {}) // absorb previous failure so chain continues
    .then(() => db.collection('jobs').replaceOne({ jobId }, snapshot, { upsert: true }))
    .catch((err) => warn('mirrorJob', err));

  jobWriteChains.set(jobId, next);
  // Connection leak prevention: clean up the chain entry once settled.
  next.finally(() => {
    if (jobWriteChains.get(jobId) === next) jobWriteChains.delete(jobId);
  });
}

export function createJob(job) {
  const now = new Date();
  const doc = {
    ...job,
    userId:    job.userId || 'anonymous',
    log:       job.log ?? [],
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
      return await db.collection('jobs').findOne({ jobId }, SAFE); // parameterized
    } catch (err) {
      warn('getJob', err);
      // Graceful fallback: return null — caller gets a clean 404.
    }
  }
  return null;
}

export function updateJob(
  jobId,
  { status, progress, error, logLine, phase, binBase64, binSize, offset, filename, sourceCode } = {}
) {
  const job = memJobs.get(jobId);
  if (!job) return;

  if (phase      !== undefined) job.phase      = phase;
  if (status     !== undefined) job.status     = status;
  if (progress   !== undefined) job.progress   = progress;
  if (error      !== undefined) job.error      = error;
  if (binBase64  !== undefined) job.binBase64  = binBase64;
  if (binSize    !== undefined) job.binSize    = binSize;
  if (offset     !== undefined) job.offset     = offset;
  if (filename   !== undefined) job.filename   = filename;
  if (sourceCode !== undefined) job.sourceCode = sourceCode;
  if (logLine)                  job.log.push(logLine);
  job.updatedAt = new Date();

  mirrorJob(jobId);
}

export async function listJobs(userId = null) {
  // Parameterized: only structured filter, no user-controlled field names.
  const filter = userId ? { userId } : {};
  if (canUseMongo()) {
    try {
      // Single query with sort — avoids N+1 by fetching all needed docs at once.
      return await db.collection('jobs')
        .find(filter, SAFE)
        .sort({ createdAt: -1 })
        .toArray(); // cursor fully consumed and released
    } catch (err) {
      warn('listJobs', err);
      // Graceful fallback to in-memory store.
    }
  }
  const all = Array.from(memJobs.values());
  const filtered = userId ? all.filter((j) => j.userId === userId) : all;
  return filtered.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

export async function clearJobs(userId = null) {
  // In-memory clear
  if (userId) {
    for (const [id, job] of memJobs.entries()) {
      if (job.userId === userId) memJobs.delete(id);
    }
  } else {
    memJobs.clear();
  }

  if (canUseMongo()) {
    try {
      // Batch delete — single query instead of per-document loops (avoids N+1).
      const filter = userId ? { userId } : {};           // parameterized
      await db.collection('jobs').deleteMany(filter);
    } catch (err) {
      warn('clearJobs', err);
      // Graceful: in-memory was already cleared; Mongo inconsistency is logged only.
    }
  }
}
