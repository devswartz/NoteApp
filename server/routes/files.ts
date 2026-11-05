// File uploads (images and attachments). Owner: Editor & Notes.
//
//   POST /api/workspaces/:id/files?pageId=<optional>
//     body: the raw bytes, sent as Content-Type: application/octet-stream
//     header: X-Filename: <URI-encoded original name>
//     → UploadedFile { id, url, name, mime, size }
//   GET  /api/files/:id → UploadedFile (metadata; members of the file's workspace only)
//   POST /api/uploads   legacy, same body and headers, no workspace
//
// Bytes are stored at $DATA_DIR/files/<id><ext> and served by serveUploads() at
// /uploads/<id><ext>. Ids are 128 random bits: an <img> can't send a bearer token,
// so the URL itself is the capability.
//
// XSS defence, two layers:
//   1. Allow-list: only extensions in SAFE_TYPES keep their extension; anything else is
//      stored without one and served as application/octet-stream.
//   2. Every file is served with X-Content-Type-Options: nosniff and
//      Content-Security-Policy: sandbox, and everything except raster images with
//      Content-Disposition: attachment, so nothing uploaded can run on our origin.
import express, { Router, type Request, type Response, type NextFunction } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError, h, param } from '../http.ts';
import { DATA_DIR, FILES_DIR } from '../config.ts';
import { db, now } from '../db.ts';
import { pageAccess, requireRole, roleIn } from '../access.ts';
import type { UploadedFile } from '../../shared/types.ts';

// Dev databases created before DATA_DIR kept files in data/uploads.
const legacy = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(FILES_DIR) && fs.existsSync(legacy)) fs.renameSync(legacy, FILES_DIR);
fs.mkdirSync(FILES_DIR, { recursive: true });

/** Files are stored on disk in FILES_DIR and served at /uploads/<name>. */
export const UPLOAD_DIR = FILES_DIR;

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Raster images: safe to show inline (SVG is deliberately not here: it can carry script). */
const INLINE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
};

/** Extensions we keep, with the Content-Type we serve them as. Everything else is application/octet-stream. */
export const SAFE_TYPES: Record<string, string> = {
  ...INLINE_TYPES,
  '.heic': 'image/heic',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json',
  '.rtf': 'application/rtf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.key': 'application/vnd.apple.keynote',
  '.pages': 'application/vnd.apple.pages',
  '.numbers': 'application/vnd.apple.numbers',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};

export const fileRoutes = Router();
const raw = express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES });

/** Extension for the stored file name: kept only if it's on the allow-list, else "". */
export function storedExt(original: string): string {
  const ext = path.extname(original).toLowerCase();
  return Object.hasOwn(SAFE_TYPES, ext) ? ext : '';
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

/** The type we record and report: from the allow-listed extension, never from the client. */
function mimeOf(ext: string): string {
  return (SAFE_TYPES[ext] ?? 'application/octet-stream').split(';')[0];
}

function store(req: Request, workspaceId: string | null, pageId: string | null): UploadedFile {
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'Empty upload');
  const name = cleanName(req);
  const ext = storedExt(name);
  const mime = mimeOf(ext);
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
      | { id: string; workspace_id: string | null; page_id: string | null; name: string; ext: string; mime: string; size: number; created_by: string }
      | undefined;
    if (!row) throw new HttpError(404, 'Not found');
    // A file attached to a page is visible exactly to the people who can view that page
    // (private notebooks included); otherwise to workspace members, or for legacy
    // workspace-less uploads only to the uploader. Always 404, never 403, so ids can't be probed.
    const visible = row.page_id
      ? !!pageAccess(row.page_id, req.user.id)
      : row.workspace_id
        ? roleIn(row.workspace_id, req.user.id) !== null
        : row.created_by === req.user.id;
    if (!visible) throw new HttpError(404, 'Not found');
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

/** Serves /uploads/<id><ext> with headers that stop uploaded content from running on our origin. */
export function serveUploads(req: Request, res: Response, next: NextFunction) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const m = /^\/([0-9a-f]{32})(\.[a-z0-9]{1,10})?$/.exec(req.path);
  const file = m ? path.join(UPLOAD_DIR, m[1] + (m[2] ?? '')) : '';
  if (!m || !fs.existsSync(file)) return res.status(404).type('text/plain').send('Not found');
  const ext = m[2] ?? '';
  const row = db.prepare('SELECT name FROM files WHERE id = ?').get(m[1]) as { name: string } | undefined;
  const name = row?.name ?? `file${ext}`;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'");
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'); // images are embedded by the native shells
  res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
  res.setHeader('Content-Type', SAFE_TYPES[ext] ?? 'application/octet-stream');
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const disposition = Object.hasOwn(INLINE_TYPES, ext) ? 'inline' : 'attachment';
  res.setHeader('Content-Disposition', `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.sendFile(file, { headers: {}, lastModified: true, cacheControl: false }, (err) => err && next(err));
}
