// Share links: "Anyone with the link can view" for one page.
//   GET    /api/pages/:id/link → { url }  (null when there's no link)
//   PUT    /api/pages/:id/link → { url }  (makes one if there isn't one yet)
//   DELETE /api/pages/:id/link → { url: null }  (the link stops working at once; turning it on again gives a new one)
// Only people who may share the page (canSharePage: notebook-level edit access, and for a private notebook its
// creator) manage links. Locked pages can't have one. The public page itself is server/publicPage.ts (GET /s/<token>).
import crypto from 'node:crypto';
import { Router } from 'express';
import { db, now } from '../db.ts';
import { canSharePage, mustManage, pageAccess } from '../access.ts';
import { HttpError, h, param } from '../http.ts';
import { PUBLIC_URL } from '../config.ts';

export const pageLinkRoutes = Router();

function mustShareByLink(pageId: string, userId: string) {
  const a = mustManage(pageAccess(pageId, userId));
  if (a.locked) throw new HttpError(409, 'Locked pages can’t be shared by link');
  if (!canSharePage(a)) throw new HttpError(403, 'Only the notebook’s creator can share pages from a private notebook');
  return a;
}

/** The link's address. PUBLIC_URL is the app's origin in production; in development it falls back to the request's. */
function linkUrl(token: string, origin: string): string {
  return `${PUBLIC_URL || origin}/s/${token}`;
}
const originOf = (req: { protocol: string; get(h: string): string | undefined }) => `${req.protocol}://${req.get('host') ?? 'localhost'}`;

const current = (pageId: string) => (db.prepare('SELECT token FROM page_links WHERE page_id = ?').get(pageId) as { token: string } | undefined)?.token ?? null;

pageLinkRoutes.get(
  '/pages/:id/link',
  h((req) => {
    const id = param(req, 'id');
    mustShareByLink(id, req.user.id);
    const token = current(id);
    return { url: token ? linkUrl(token, originOf(req)) : null };
  }),
);

pageLinkRoutes.put(
  '/pages/:id/link',
  h((req) => {
    const id = param(req, 'id');
    mustShareByLink(id, req.user.id);
    let token = current(id);
    if (!token) {
      token = crypto.randomBytes(24).toString('base64url'); // 32 characters, 192 bits
      db.prepare('INSERT INTO page_links (token, page_id, created_by, created_at) VALUES (?, ?, ?, ?)').run(token, id, req.user.id, now());
    }
    return { url: linkUrl(token, originOf(req)) };
  }),
);

pageLinkRoutes.delete(
  '/pages/:id/link',
  h((req) => {
    const id = param(req, 'id');
    mustShareByLink(id, req.user.id);
    db.prepare('DELETE FROM page_links WHERE page_id = ?').run(id);
    return { url: null };
  }),
);
