import { Router } from 'express';
import {
  createGroup,
  listGroups,
  getGroup,
  updateGroupMembers,
  deleteGroup,
} from '../services/storage.js';
import { resolveUserId } from '../services/user-resolver.js';
import { asyncRoute } from '../middleware/errorHandler.js';

const router = Router();

/** Device groups ("fleets"): named sets of boards for one-action OTA updates. */
router.post('/api/groups', asyncRoute(async (req, res) => {
  const userId = await resolveUserId(req);
  const { name = 'Untitled group', memberIds = [] } = req.body ?? {};
  const group = await createGroup(userId, name, memberIds);
  res.json({ group });
}));

router.get('/api/groups', asyncRoute(async (req, res) => {
  const userId = await resolveUserId(req);
  const groups = await listGroups(userId);
  res.json({ count: groups.length, groups });
}));

router.get('/api/groups/:groupId', asyncRoute(async (req, res) => {
  const group = await getGroup(String(req.params.groupId));
  if (!group) return res.status(404).json({ error: 'Group not found.' });
  res.json({ group });
}));

router.patch('/api/groups/:groupId/members', asyncRoute(async (req, res) => {
  const userId = await resolveUserId(req);
  const { add = [], remove = [] } = req.body ?? {};
  const group = await updateGroupMembers(String(req.params.groupId), userId, { add, remove });
  if (!group) return res.status(404).json({ error: 'Group not found.' });
  res.json({ group });
}));

router.delete('/api/groups/:groupId', asyncRoute(async (req, res) => {
  const userId = await resolveUserId(req);
  const ok = await deleteGroup(String(req.params.groupId), userId);
  if (!ok) return res.status(404).json({ error: 'Group not found.' });
  res.json({ ok: true });
}));

export default router;
