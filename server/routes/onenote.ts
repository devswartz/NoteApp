// Import from OneNote (Microsoft Graph), #117. Owner: Import. The logic is in server/onenote.ts.
// Hidden unless MS_CLIENT_ID and MS_CLIENT_SECRET are set: every route then answers 404 (oneNoteGate,
// mounted before auth so even signed-out callers can't tell the feature exists).
import { Router, type RequestHandler, type Response } from 'express';
import { HttpError, h, param } from '../http.ts';
import { takeImport } from '../ratelimit.ts';
import { IS_PROD } from '../config.ts';
import { authorizeFlow, BadState, cancelJob, completeFlow, connectionFor, COOKIE, FLOW_TTL_MS, jobFor, listNotebooks, oneNoteConfig, startFlow, startJob } from '../onenote.ts';

export const oneNoteGate: RequestHandler = (_req, res, next) => (oneNoteConfig() ? next() : void res.status(404).json({ error: 'Not found' }));

const COOKIE_PATH = '/api/import/onenote';
const cookieAttrs = (maxAge: number) => `Path=${COOKIE_PATH}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${IS_PROD ? '; Secure' : ''}`;
const readCookie = (header: string | undefined): string | undefined => {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return undefined;
};
const plain = (res: Response, status: number, text: string) => {
  res.status(status).setHeader('Cache-Control', 'no-store');
  res.type('text/plain').send(text);
};

/** Browser navigations from and to Microsoft: they carry no bearer token, so they're public and use a one-time ticket / state + cookie. */
export const publicOneNoteRoutes = Router();

/** GET /import/onenote/authorize?ticket=… → 302 to Microsoft sign-in (the ticket comes from POST /import/onenote/start). */
publicOneNoteRoutes.get('/import/onenote/authorize', (req, res) => {
  const r = authorizeFlow(req.query.ticket);
  if (!r) return plain(res, 400, 'This sign-in link has expired. Go back to the app and start the OneNote import again.');
  res.setHeader('Set-Cookie', `${COOKIE}=${r.cookie}; ${cookieAttrs(FLOW_TTL_MS / 1000)}`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.redirect(302, r.location);
});

/** GET /import/onenote/callback?code&state → 302 back to the app (Settings) with a connection id, or 400 for a bad state. */
publicOneNoteRoutes.get(
  '/import/onenote/callback',
  h(async (req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE}=; ${cookieAttrs(0)}`);
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const { redirect } = await completeFlow(req.query, readCookie(req.headers.cookie));
      res.setHeader('Cache-Control', 'no-store');
      res.redirect(302, redirect);
    } catch (e) {
      if (e instanceof BadState) return plain(res, 400, 'This sign-in could not be verified (it expired, was already used, or was started in another browser). Go back to the app and start the OneNote import again.');
      throw e;
    }
  }),
);

/** Signed-in routes (behind requireAuth + requireVerifiedEmail). */
export const oneNoteRoutes = Router();

/** GET /import/onenote → {enabled:true} (404 when the feature is off: the UI then hides it). */
oneNoteRoutes.get('/import/onenote', h(() => ({ enabled: true })));

/** POST /import/onenote/start {workspaceId} → {url}: open it in the browser to sign in with Microsoft. */
oneNoteRoutes.post(
  '/import/onenote/start',
  h((req) => {
    const ws = req.body?.workspaceId;
    if (typeof ws !== 'string' || !ws) throw new HttpError(400, 'workspaceId is required');
    return startFlow(req.user.id, ws);
  }),
);

/** GET /import/onenote/connections/:id/notebooks → [{id, name}] from the signed-in Microsoft account. */
oneNoteRoutes.get(
  '/import/onenote/connections/:id/notebooks',
  h(async (req) => {
    const conn = connectionFor(param(req, 'id'), req.user.id);
    return { workspaceId: conn.workspaceId, account: conn.account, notebooks: await listNotebooks(conn) };
  }),
);

/** POST /import/onenote/connections/:id/import {notebookIds, confirmedAccount: true} → the job (202). One OneNote import at a time server-wide (its own slot), rate limited per user. */
oneNoteRoutes.post(
  '/import/onenote/connections/:id/import',
  h((req, res) => {
    const id = param(req, 'id');
    const conn = connectionFor(id, req.user.id);
    if (req.body?.confirmedAccount !== true) throw new HttpError(400, 'Confirm the Microsoft account first');
    const ids = req.body?.notebookIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > 50 || ids.some((x) => typeof x !== 'string' || x.length > 200)) throw new HttpError(400, 'Pick one or more notebooks');
    const { wait, done } = takeImport(req.user.id, 'onenote');
    if (wait) {
      res.setHeader('Retry-After', String(wait));
      throw new HttpError(429, `Another import is running, or you have imported several times recently. Try again in ${wait < 60 ? `${wait} seconds` : `${Math.ceil(wait / 60)} minutes`}.`);
    }
    try {
      res.status(202);
      return startJob(conn, id, [...new Set(ids as string[])], done);
    } catch (e) {
      done();
      throw e;
    }
  }),
);

/** GET /import/onenote/jobs/:id → progress (only for the user who started it). */
oneNoteRoutes.get('/import/onenote/jobs/:id', h((req) => jobFor(param(req, 'id'), req.user.id)));

/** POST /import/onenote/jobs/:id/cancel → the job (owner only). What's imported so far stays, marked "(incomplete)". */
oneNoteRoutes.post('/import/onenote/jobs/:id/cancel', h((req) => cancelJob(param(req, 'id'), req.user.id)));
