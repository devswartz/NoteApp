// Workspace export (zip) and import, and "Export my data" for everyone. Owner: Foundation.
import express, { Router, type RequestHandler } from 'express';
import { requireRole, sessionUnlocked } from '../access.ts';
import { db } from '../db.ts';
import { publish } from '../events.ts';
import { exportWorkspace, importWorkspace } from '../export.ts';
import { HttpError, h, param } from '../http.ts';
import { takeDataExport, takeExport, takeImport } from '../ratelimit.ts';
import { exportUserData } from '../userExport.ts';

/** Largest import body. Matches Cloudflare's free-plan upload limit, so a bigger file never gets through the tunnel anyway. */
export const MAX_IMPORT_BYTES = 100 * 1024 * 1024;

function tooMany(res: express.Response, wait: number, what: string) {
  res.setHeader('Retry-After', String(wait));
  res.status(429).json({ error: `${what} Try again in ${wait < 60 ? `${wait} seconds` : `${Math.ceil(wait / 60)} minutes`}.` });
}

/** Admission before the body is read: a refused import never buffers its upload. Released when the response ends. */
const importGate: RequestHandler = (req, res, next) => {
  // Refuse a declared-too-large body now (express.raw would also refuse it, but only after the whole upload
  // has arrived and been discarded), and close the connection rather than read the rest.
  if (Number(req.get('content-length')) > MAX_IMPORT_BYTES) {
    res.setHeader('Connection', 'close');
    return res.status(413).json({ error: `That file is too large to import (the limit is ${MAX_IMPORT_BYTES / 1024 / 1024} MB)` });
  }
  const { wait, done } = takeImport(req.user.id);
  if (wait) return tooMany(res, wait, 'Another import is running, or you have imported several workspaces recently.');
  res.on('finish', done);
  res.on('close', done);
  next();
};

export const exportRoutes = Router();

/** GET /workspaces/:id/export → application/zip (owners and admins). */
exportRoutes.get(
  '/workspaces/:id/export',
  h((req, res) => {
    const wsId = param(req, 'id');
    requireRole(wsId, req.user.id, 'admin');
    const wait = takeExport(req.user.id);
    if (wait) return tooMany(res, wait, 'You have exported several times recently.');
    const { zip, filename } = exportWorkspace(wsId, req.user.id);
    sendZip(res, zip, filename);
  }),
);

/** GET /me/export → application/zip: the caller's own data (any signed-in user; server/userExport.ts). */
exportRoutes.get(
  '/me/export',
  h((req, res) => {
    // Locked pages (server/locks.ts) are part of "my data": exporting needs them unlocked on this sign-in first.
    if (db.prepare('SELECT 1 FROM pages WHERE locked_by = ? LIMIT 1').get(req.user.id) && !sessionUnlocked(req.user.id, req.sid))
      throw new HttpError(403, 'Unlock your locked notes first: they are included in your data export.', 'locked');
    const wait = takeDataExport(req.user.id);
    if (wait) return tooMany(res, wait, 'You have exported your data several times recently.');
    const { zip, filename } = exportUserData(req.user.id);
    sendZip(res, zip, filename);
  }),
);

function sendZip(res: express.Response, zip: Buffer, filename: string) {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/[^\w .()-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader('Cache-Control', 'no-store');
  res.end(zip);
}

/** POST /workspaces/import (body: the export zip) → { workspaceId, name }. Creates a new workspace. */
exportRoutes.post(
  '/workspaces/import',
  importGate,
  express.raw({ type: () => true, limit: MAX_IMPORT_BYTES }),
  h(async (req) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'Send the export .zip as the request body');
    const r = await importWorkspace(req.body, req.user.id);
    publish({ type: 'workspaces' }, { userIds: [req.user.id] });
    return r;
  }),
);
