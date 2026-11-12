// File uploads (images and attachments). Owner: Editor & Notes.
//
//   POST /api/workspaces/:id/files?pageId=<optional>
//     body: the raw bytes, sent as Content-Type: application/octet-stream
//     header: X-Filename: <URI-encoded original name>
//     → UploadedFile { id, url, name, mime, size }
//   GET  /api/files/:id → UploadedFile (metadata; members of the file's workspace only)
//   POST /api/uploads   legacy, same body and headers, no workspace
//
//   GET  /api/files/key → FileKey (a fresh key for signing upload links; also in every AuthSession)
//
// Bytes are stored at $DATA_DIR/files/<id><ext> and served by serveUploads() at
// /uploads/<id><ext>, but only with a valid signature from someone who may see the file
// (shared/fileLinks.ts explains the signed links and why they are links, not cookies):
//   no signature             → 401 (a browser opening an old unsigned link is sent to the app,
//                              which signs it for whoever is signed in: /open-file/<name>)
//   bad or expired signature → 403
//   signer can't see it      → 403 (canReadFile: page, page share, template or workspace)
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
import { PAGE_VISIBLE, onAccessChange, pageAccess, requireRole, roleIn } from '../access.ts';
import { fileKeyFor, fileKeySecret, getUser } from '../auth.ts';
import { FILE_KEY_MAX_S, signFileName } from '../../shared/fileLinks.ts';
import { visibleTemplate } from '../templates.ts';
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
    let pageId: string | null = null;
    if (typeof req.query.pageId === 'string' && req.query.pageId) {
      // Into a page: whoever may edit it (a page share with edit counts, #98).
      const a = pageAccess(req.query.pageId, req.user.id);
      if (!a || a.workspaceId !== workspaceId) throw new HttpError(404, 'Page not found');
      if (!a.canEdit) throw new HttpError(403, 'You have view-only access');
      pageId = req.query.pageId;
    } else requireRole(workspaceId, req.user.id, 'member');
    return store(req, workspaceId, pageId);
  }),
);

export interface FileMeta {
  id: string;
  workspace_id: string | null;
  page_id: string | null;
  template_id?: string | null;
  name: string;
  ext: string;
  mime: string;
  size: number;
  created_by: string;
}

/**
 * Who may see a file's metadata. A file attached to a page is visible exactly to the people who can
 * view that page (private notebooks included); a template's copy to whoever can see that template;
 * otherwise to workspace members, or for legacy workspace-less uploads only to the uploader.
 */
export function fileVisible(row: FileMeta, userId: string): boolean {
  if (row.page_id) return !!pageAccess(row.page_id, userId);
  if (row.template_id) return !!visibleTemplate(row.template_id, userId);
  if (row.workspace_id) return roleIn(row.workspace_id, userId) !== null;
  return row.created_by === userId;
}

// ── Who may read a file's bytes ──

const readCache = new Map<string, { ok: boolean; at: number }>(); // `${fileId}:${userId}` → allowed
const READ_CACHE_MS = 60_000;
const READ_CACHE_MAX = 20_000;
onAccessChange(() => readCache.clear()); // a role, membership, share or move changed: ask again

/**
 * May `userId` read file `fileId` (the bytes at /uploads)? Yes when they may see its metadata
 * (fileVisible: the page it was uploaded to, its template or its workspace), or when it appears in
 * a page they can open, or in that page's version history. The second rule keeps images working
 * after content was copied or moved to another page, for page-share grantees who are not workspace
 * members, and for old files with no page recorded. A "yes" is cached for a minute and dropped
 * whenever access is taken away anywhere.
 */
export function canReadFile(fileId: string, userId: string): boolean {
  const key = `${fileId}:${userId}`;
  const hit = readCache.get(key);
  if (hit && Date.now() - hit.at < READ_CACHE_MS) return hit.ok;
  const row = db.prepare('SELECT * FROM files WHERE id = ?').get(fileId) as FileMeta | undefined;
  const ok = (!!row && fileVisible(row, userId)) || referencedInVisiblePage(fileId, userId);
  // Only "yes" is cached: a new share or membership doesn't announce itself (accessChanged is for losing access).
  if (ok) {
    if (readCache.size >= READ_CACHE_MAX) readCache.clear();
    readCache.set(key, { ok, at: Date.now() });
  }
  return ok;
}

/** True if a page `userId` can open (or one of its saved versions) contains the file id. */
function referencedInVisiblePage(fileId: string, userId: string): boolean {
  const needle = Buffer.from(fileId); // Yjs stores attribute strings as plain UTF-8 inside the update
  return !!db
    .prepare(
      `SELECT 1 FROM pages pg JOIN sections s ON s.id = pg.section_id JOIN notebooks n ON n.id = s.notebook_id
       WHERE ${PAGE_VISIBLE}
         AND (instr(pg.ydoc, @needle) > 0 OR EXISTS (SELECT 1 FROM page_versions v WHERE v.page_id = pg.id AND instr(v.ydoc, @needle) > 0))
       LIMIT 1`,
    )
    .get({ userId, needle });
}

/** Tests only. */
export function clearFileReadCache() {
  readCache.clear();
}

/**
 * Checks a signed upload link's query (u, e, s) for stored file `name`. Returns the signer's user
 * id, or a status: 401 without a signature, 403 for a bad or expired one or an unverified account.
 */
export function verifyFileSignature(name: string, q: Record<string, unknown>, nowS = Math.floor(Date.now() / 1000)): { userId: string } | { status: 401 | 403 } {
  const { u, e, s } = q;
  if (typeof u !== 'string' || typeof e !== 'string' || typeof s !== 'string' || !u || !e || !s) return { status: 401 };
  const exp = Number(e);
  // Expired, or further out than any key we issue (a forged expiry).
  if (!/^\d{1,12}$/.test(e) || exp <= nowS || exp > nowS + FILE_KEY_MAX_S + 60) return { status: 403 };
  if (!/^[0-9a-f]{32}$/.test(s) || u.length > 100) return { status: 403 };
  const want = Buffer.from(signFileName(fileKeySecret(u, exp), name));
  if (!crypto.timingSafeEqual(want, Buffer.from(s))) return { status: 403 };
  const user = getUser(u);
  if (!user || !user.emailVerified) return { status: 403 };
  return { userId: u };
}

/** A fresh key for signing upload links (the client also gets one with every session refresh). */
fileRoutes.get(
  '/files/key',
  h((req) => fileKeyFor(req.user.id)),
);

fileRoutes.get(
  '/files/:id',
  h((req) => {
    const row = db.prepare('SELECT * FROM files WHERE id = ?').get(param(req, 'id')) as FileMeta | undefined;
    // Always 404, never 403, so ids can't be probed.
    if (!row || !fileVisible(row, req.user.id)) throw new HttpError(404, 'Not found');
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

/** Is this request a browser opening the link itself (a tab, not an <img> or fetch)? */
const isNavigation = (req: Request) => {
  const dest = req.get('sec-fetch-dest');
  return dest ? dest === 'document' : /text\/html/.test(req.get('accept') ?? '');
};

const DENIED = 'This link has expired, or you do not have access to this file';

/**
 * Serves /uploads/<id><ext> to someone who may see it (signed link: see the top of this file), with
 * headers that stop uploaded content from running on our origin.
 */
export function serveUploads(req: Request, res: Response, next: NextFunction) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const m = /^\/([0-9a-f]{32})(\.[a-z0-9]{1,10})?$/.exec(req.path);
  if (!m) return res.status(404).type('text/plain').send('Not found');
  const ext = m[2] ?? '';
  const stored = m[1] + ext;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  const signed = verifyFileSignature(stored, req.query as Record<string, unknown>);
  if ('status' in signed) {
    // An old unsigned link opened in a browser tab: the web app signs it for whoever is signed in there.
    if (signed.status === 401 && isNavigation(req)) return res.redirect(302, `/open-file/${stored}`);
    return res
      .status(signed.status)
      .type('text/plain')
      .send(signed.status === 401 ? 'Sign in to open this file' : DENIED);
  }
  if (!canReadFile(m[1], signed.userId)) return res.status(403).type('text/plain').send(DENIED);
  const file = path.join(UPLOAD_DIR, stored);
  if (!fs.existsSync(file)) return res.status(404).type('text/plain').send('Not found');
  const row = db.prepare('SELECT name FROM files WHERE id = ?').get(m[1]) as { name: string } | undefined;
  const name = row?.name ?? `file${ext}`;
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'");
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'); // images are embedded by the native shells
  // Private (never in a shared cache), and only while the link itself is valid.
  const left = Math.max(0, Number(req.query.e) - Math.floor(Date.now() / 1000));
  res.setHeader('Cache-Control', `private, max-age=${Math.min(left, 6 * 3600)}`);
  res.setHeader('Content-Type', SAFE_TYPES[ext] ?? 'application/octet-stream');
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const disposition = Object.hasOwn(INLINE_TYPES, ext) ? 'inline' : 'attachment';
  res.setHeader('Content-Disposition', `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.sendFile(file, { headers: {}, lastModified: true, cacheControl: false }, (err) => err && next(err));
}
