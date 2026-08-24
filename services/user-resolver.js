import { getDevice, listDevices } from './storage.js';

export async function resolveUserId(req, deviceId = null) {
  if (req.userId) return String(req.userId);
  if (req.headers && req.headers['x-user-id']) return String(req.headers['x-user-id']);

  if (req.body && (req.body.userId || req.body.uid)) return String(req.body.userId || req.body.uid);
  if (req.query && (req.query.userId || req.query.uid)) return String(req.query.userId || req.query.uid);

  if (deviceId) {
    const dev = await getDevice(deviceId);
    if (dev && dev.userId) return String(dev.userId);
  }

  const devices = await listDevices();
  const withUser = devices.find((d) => d.userId);
  if (withUser && withUser.userId) return String(withUser.userId);

  return 'anonymous';
}
