// Workspace export (zip) and import. Owner: Foundation.
import express, { Router } from 'express';
import { requireRole } from '../access.ts';
import { publish } from '../events.ts';
import { exportWorkspace, importWorkspace } from '../export.ts';
import { HttpError, h, param } from '../http.ts';

export const exportRoutes = Router();

/** GET /workspaces/:id/export → application/zip (owners and admins). */
exportRoutes.get(
  '/workspaces/:id/export',
  h((req, res) => {
    const wsId = param(req, 'id');
    requireRole(wsId, req.user.id, 'admin');
    const { zip, filename } = exportWorkspace(wsId, req.user.id);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/[^\w .()-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('Cache-Control', 'no-store');
    res.end(zip);
  }),
);

/** POST /workspaces/import (body: the export zip) → { workspaceId, name }. Creates a new workspace. */
exportRoutes.post(
  '/workspaces/import',
  express.raw({ type: () => true, limit: '200mb' }),
  h((req) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'Send the export .zip as the request body');
    const r = importWorkspace(req.body, req.user.id);
    publish({ type: 'workspaces' }, { userIds: [req.user.id] });
    return r;
  }),
);
