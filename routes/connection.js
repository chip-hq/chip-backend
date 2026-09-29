import { Router } from 'express';
import { WebSocket } from 'ws';
import { deviceSockets } from '../services/websocket.js';

const router = Router();

// Read-only USB relay status for MCP clients. This is intentionally narrower
// than the removed Fleet/device API.
router.get('/api/connection', (req, res) => {
  const connections = [];
  for (const [deviceId, socket] of deviceSockets.entries()) {
    if (socket.readyState !== WebSocket.OPEN) continue;
    if (req.userId && socket.userId && socket.userId !== req.userId) continue;
    connections.push({
      deviceId,
      connected: socket.boardConnected !== false,
      chip: socket.chip || null,
      board: socket.board || null,
      transport: 'usb',
    });
  }
  res.json({ connected: connections.some((item) => item.connected), connections });
});

export default router;
