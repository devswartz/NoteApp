// The Trash view's API: list what was deleted, restore it, delete it for good, empty the Trash. See server/trash.ts.
import { Router } from 'express';
import { requireRole } from '../access.ts';
import { HttpError, h, param } from '../http.ts';
import { emptyTrash, listTrash, purgeItem, restoreItem, type TrashKind } from '../trash.ts';

export const trashRoutes = Router();

const kindOf = (v: string): TrashKind => {
  if (v !== 'page' && v !== 'section' && v !== 'notebook') throw new HttpError(404, 'Not found');
  return v;
};

// What the caller may see of the workspace's Trash (viewers and page-share holders: nothing).
trashRoutes.get(
  '/workspaces/:id/trash',
  h((req) => {
    const workspaceId = param(req, 'id');
    requireRole(workspaceId, req.user.id, 'viewer');
    return listTrash(workspaceId, req.user.id);
  }),
);

trashRoutes.post(
  '/trash/:kind/:id/restore',
  h((req) => restoreItem(kindOf(param(req, 'kind')), param(req, 'id'), req.user.id)),
);

trashRoutes.delete(
  '/trash/:kind/:id',
  h((req) => {
    purgeItem(kindOf(param(req, 'kind')), param(req, 'id'), req.user.id);
    return { ok: true };
  }),
);

// Owners and admins only.
trashRoutes.delete(
  '/workspaces/:id/trash',
  h((req) => {
    const workspaceId = param(req, 'id');
    requireRole(workspaceId, req.user.id, 'viewer');
    return { removed: emptyTrash(workspaceId, req.user.id) };
  }),
);
