// File uploads (images and attachments). Owner: Editor & Notes.
//
//   POST /api/workspaces/:id/files?type=<mime type>&pageId=<optional>
//     body: the raw bytes, sent as Content-Type: application/octet-stream
//     header: X-Filename: <URI-encoded original name>
//     (the type is a query param, not a header, so cross-origin shells need no extra CORS header)
//     → UploadedFile { id, url, name, mime, size }
//   GET  /api/files/:id → UploadedFile (metadata; members of the file's workspace only)
//   POST /api/uploads   legacy, same body and headers, no workspace
//
// Bytes are stored at $DATA_DIR/files/<id><ext> and served at /uploads/<id><ext>
// (see server/app.ts). Ids are 128 random bits: an <img> can't send a bearer token,
// so the URL itself is the capability. Types a browser would execute when opened
// directly (HTML, SVG, XML, JS) are stored with a ".bin" suffix so they download
// as application/octet-stream instead of running on our origin.
import express, { Router, type Request } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError, h, param } from '../http.ts';
import { DATA_DIR, FILES_DIR } from '../config.ts';
import { db, now } from '../db.ts';
import { pageAccess, requireRole } from '../access.ts';
import type { UploadedFile } from '../../shared/types.ts';

// Dev databases created before DATA_DIR kept files in data/uploads.
const legacy = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(FILES_DIR) && fs.existsSync(legacy)) fs.renameSync(legacy, FILES_DIR);
fs.mkdirSync(FILES_DIR, { recursive: true });

/** Files are stored on disk in FILES_DIR and served at /uploads/<name>. */
export const UPLOAD_DIR = FILES_DIR;

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const ACTIVE_EXT = new Set(['.html', '.htm', '.xhtml', '.shtml', '.svg', '.svgz', '.xml', '.xsl', '.js', '.mjs']);

export const fileRoutes = Router();
const raw = express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES });

/** Safe extension for the stored file name ("" if none). */
export function storedExt(original: string): string {
  const ext = path.extname(original).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
  if (ext === '.') return '';
  return ACTIVE_EXT.has(ext) ? `${ext}.bin` : ext;
}

function cleanName(req: Request): string {
  let name = 'file';
  try {
    name = decodeURIComponent(String(req.headers['x-filename'] ?? 'file'));
  } catch {
    name = String(req.headers['x-filename'] ?? 'file');
  }
  // eslint-disable-next-line no-control-regex
  name = path.basename(name.replace(/\\/g, '/')).replace(/[\u0000-\u001f]/g, '').trim();
  return name.slice(0, 200) || 'file';
}

function mimeOf(req: Request, name: string): string {
  const declared = String(req.query.type ?? req.headers['x-file-type'] ?? '').toLowerCase();
  const ct = String(req.headers['content-type'] ?? '').toLowerCase().split(';')[0];
  const m = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(declared) ? declared : ct && ct !== 'application/octet-stream' ? ct : '';
  if (m && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(m)) return m;
  const ext = path.extname(name).toLowerCase();
  const byExt: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.zip': 'application/zip',
  };
  return byExt[ext] ?? 'application/octet-stream';
}

function store(req: Request, workspaceId: string | null, pageId: string | null): UploadedFile {
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'Empty upload');
  const name = cleanName(req);
  const mime = mimeOf(req, name);
  const ext = storedExt(name);
  const id = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(UPLOAD_DIR, id + ext), req.body);
  db.prepare(
    'INSERT INTO files (id, workspace_id, page_id, name, ext, mime, size, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, workspaceId, pageId, name, ext, mime, req.body.length, req.user.id, now());
  return { id, url: `/uploads/${id}${ext}`, name, mime, size: req.body.length };
}

fileRoutes.post(
  '/workspaces/:id/files',
  raw,
  h((req) => {
    const workspaceId = param(req, 'id');
    requireRole(workspaceId, req.user.id, 'member');
    let pageId: string | null = null;
    if (typeof req.query.pageId === 'string' && req.query.pageId) {
      const a = pageAccess(req.query.pageId, req.user.id);
      if (!a || a.workspaceId !== workspaceId) throw new HttpError(404, 'Page not found');
      pageId = req.query.pageId;
    }
    return store(req, workspaceId, pageId);
  }),
);

fileRoutes.get(
  '/files/:id',
  h((req) => {
    const row = db.prepare('SELECT * FROM files WHERE id = ?').get(param(req, 'id')) as
      | { id: string; workspace_id: string | null; name: string; ext: string; mime: string; size: number; created_by: string }
      | undefined;
    if (!row) throw new HttpError(404, 'Not found');
    if (row.workspace_id) requireRole(row.workspace_id, req.user.id, 'viewer');
    else if (row.created_by !== req.user.id) throw new HttpError(404, 'Not found');
    return { id: row.id, url: `/uploads/${row.id}${row.ext}`, name: row.name, mime: row.mime, size: row.size } satisfies UploadedFile;
  }),
);

fileRoutes.post(
  '/uploads',
  raw,
  h((req) => store(req, null, null)),
);

/** Turn express.raw's "too large" error into a clear 413. */
fileRoutes.use((err: { type?: string }, _req: Request, _res: express.Response, next: express.NextFunction) => {
  if (err?.type === 'entity.too.large') return next(new HttpError(413, `Files can be up to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`));
  next(err);
});
