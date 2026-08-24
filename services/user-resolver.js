// services/user-resolver.js — Helper to reliably resolve the owner userId from token, headers, params, or registered devices.

import { getDevice, listDevices } from './storage.js';

export async function resolveUserId(req, deviceId = null) {
  // 1. Direct from Bearer JWT or x-user-id middleware
  if (req.userId) return String(req.userId);
  if (req.headers && req.headers['x-user-id']) return String(req.headers['x-user-id']);

  // 2. From body or query params
  if (req.body && (req.body.userId || req.body.uid)) return String(req.body.userId || req.body.uid);
  if (req.query && (req.query.userId || req.query.uid)) return String(req.query.userId || req.query.uid);

  // 3. From target device
  if (deviceId) {
    const dev = await getDevice(deviceId);
    if (dev && dev.userId) return String(dev.userId);
  }

  // 4. From any active registered device
  const devices = await listDevices();
  const withUser = devices.find((d) => d.userId);
  if (withUser && withUser.userId) return String(withUser.userId);

  return 'anonymous';
}
