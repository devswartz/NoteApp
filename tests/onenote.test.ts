// Import from OneNote (#117): the OAuth flow (state + cookie binding), the hidden-without-env switch, and a full
// import replayed from recorded Microsoft Graph responses (tests/fixtures/onenote). No live calls: deps.fetch is
// replaced, and any URL that isn't in the fixtures fails the test.
import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as Y from 'yjs';
import { startTestApp, type TestApp, type TestUser } from './helpers/app.ts';

process.env.MS_CLIENT_ID = 'test-client-id';
process.env.MS_CLIENT_SECRET = 'test-client-secret';

const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'onenote');
type Fx = { status?: number; json?: unknown; file?: string; base64?: string; type?: string };
const graph = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'graph.json'), 'utf8')) as Record<string, Fx>;

let app: TestApp;
let me: TestUser;
let other: TestUser;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let on: any;
const calls: { url: string; auth: string | null }[] = [];
const tokenRequests: Record<string, string>[] = [];
const sleeps: number[] = [];
/** While set, Retry-After waits block until it resolves (keeps a job running). */
let hold: Promise<void> | null = null;
/** Graph paths that answer 429 (Retry-After: 3) this many more times before the fixture. */
const throttle = new Map<string, number>();

before(async () => {
  app = await startTestApp();
  on = await import('../server/onenote.ts');
  [me, other] = await Promise.all([app.signUp('OneNoteMe'), app.signUp('OneNoteOther')]);
  on.deps.sleep = async (ms: number) => {
    sleeps.push(ms);
    await hold;
  };
  on.deps.fetch = async (url: string, init: RequestInit = {}) => {
    const auth = new Headers(init.headers).get('authorization');
    calls.push({ url, auth });
    if (url === 'https://login.microsoftonline.com/common/oauth2/v2.0/token') {
      tokenRequests.push(Object.fromEntries(new URLSearchParams(String(init.body))));
      return Response.json({ token_type: 'Bearer', access_token: 'graph-access-token', refresh_token: 'graph-refresh-token', expires_in: 3600 });
    }
    assert.ok(url.startsWith(on.GRAPH_BASE + '/'), `unexpected request to ${url}`);
    assert.equal(auth, 'Bearer graph-access-token');
    const key = decodeURIComponent(url.slice(on.GRAPH_BASE.length));
    const left = throttle.get(key) ?? 0;
    if (left > 0) {
      throttle.set(key, left - 1);
      return new Response(JSON.stringify({ error: { code: '20166', message: 'Too many requests' } }), { status: 429, headers: { 'retry-after': '3' } });
    }
    const fx = graph[key];
    assert.ok(fx, `no recorded Graph response for ${key}`);
    if (fx.json !== undefined) return Response.json(fx.json, { status: fx.status ?? 200 });
    const body = fx.file ? fs.readFileSync(path.join(FIXTURES, fx.file)) : Buffer.from(fx.base64!, 'base64');
    return new Response(body, { status: fx.status ?? 200, headers: { 'content-type': fx.type ?? 'application/octet-stream' } });
  };
});
after(() => app.close());
beforeEach(async () => {
  on.resetOneNote();
  (await import('../server/ratelimit.ts')).resetRateLimits();
  calls.length = 0;
  tokenRequests.length = 0;
  sleeps.length = 0;
  throttle.clear();
});

/** Steps 1–2: start, follow the one-time link; returns Microsoft's URL, its state and the flow cookie. */
async function begin(user = me) {
  const s = await app.call('POST', '/import/onenote/start', user.token, { workspaceId: user.wsId });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  const r = await fetch(s.data.url.replace(/^https?:\/\/[^/]+/, app.origin), { redirect: 'manual' });
  assert.equal(r.status, 302);
  const location = new URL(r.headers.get('location')!);
  const cookie = r.headers.get('set-cookie')!.split(';')[0];
  return { location, state: location.searchParams.get('state')!, cookie };
}
const callback = (qs: string, cookie?: string) => fetch(`${app.origin}/api/import/onenote/callback?${qs}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });

/** The whole sign-in; returns the connection id the app receives. */
async function connect(user = me): Promise<string> {
  const { state, cookie } = await begin(user);
  const r = await callback(`code=auth-code-1&state=${encodeURIComponent(state)}`, cookie);
  assert.equal(r.status, 302);
  const back = new URL(r.headers.get('location')!);
  assert.equal(back.pathname, `/w/${user.wsId}/settings`);
  return back.searchParams.get('onenote')!;
}

async function waitForJob(id: string, token = me.token) {
  for (let i = 0; i < 500; i++) {
    const j = await app.call('GET', `/import/onenote/jobs/${id}`, token);
    if (j.data.status !== 'running') return j.data;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('import did not finish');
}

test('the feature is hidden (404 everywhere, even signed out) without MS_CLIENT_ID / MS_CLIENT_SECRET', async () => {
  const saved = process.env.MS_CLIENT_SECRET;
  delete process.env.MS_CLIENT_SECRET;
  try {
    for (const token of [me.token, undefined]) {
      assert.equal((await app.call('GET', '/import/onenote', token)).status, 404);
      assert.equal((await app.call('POST', '/import/onenote/start', token, { workspaceId: me.wsId })).status, 404);
      assert.equal((await app.call('GET', '/import/onenote/jobs/x', token)).status, 404);
    }
    assert.equal((await fetch(`${app.origin}/api/import/onenote/authorize?ticket=x`, { redirect: 'manual' })).status, 404);
    assert.equal((await callback('code=c&state=s')).status, 404);
  } finally {
    process.env.MS_CLIENT_SECRET = saved;
  }
  assert.deepEqual((await app.call('GET', '/import/onenote', me.token)).data, { enabled: true });
});

test('sign-in: PKCE + common authority + the fixed redirect URI; the code is exchanged with the verifier and secret', async () => {
  const { location, state, cookie } = await begin();
  assert.equal(location.origin + location.pathname, 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
  const q = location.searchParams;
  assert.equal(q.get('client_id'), 'test-client-id');
  assert.equal(q.get('redirect_uri'), 'http://localhost:5173/api/import/onenote/callback');
  assert.equal(q.get('scope'), 'Notes.Read offline_access User.Read');
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.ok(state.length >= 32);
  assert.match(cookie, /^onenote_flow=/);
  const r = await callback(`code=auth-code-1&state=${encodeURIComponent(state)}`, cookie);
  assert.equal(r.status, 302);
  const [t] = tokenRequests;
  assert.equal(t.grant_type, 'authorization_code');
  assert.equal(t.client_secret, 'test-client-secret');
  assert.equal(t.code, 'auth-code-1');
  // The verifier matches the challenge sent to Microsoft.
  const crypto = await import('node:crypto');
  assert.equal(crypto.createHash('sha256').update(t.code_verifier).digest('base64url'), q.get('code_challenge'));
  // The browser only gets an opaque id; no token appears anywhere in the redirect.
  assert.doesNotMatch(r.headers.get('location')!, /graph-access-token|graph-refresh-token/);
  // The ticket is single-use.
  const s = await app.call('POST', '/import/onenote/start', me.token, { workspaceId: me.wsId });
  const link = s.data.url.replace(/^https?:\/\/[^/]+/, app.origin);
  assert.equal((await fetch(link, { redirect: 'manual' })).status, 302);
  assert.equal((await fetch(link, { redirect: 'manual' })).status, 400);
});

test('an invalid state is rejected: unknown, missing cookie, wrong cookie, replayed', async () => {
  const { state, cookie } = await begin();
  assert.equal((await callback(`code=c&state=not-a-real-state`, cookie)).status, 400);
  assert.equal((await callback(`code=c&state=${encodeURIComponent(state)}`)).status, 400, 'no flow cookie (e.g. a link crafted by someone else)');
  assert.equal((await callback(`code=c&state=${encodeURIComponent(state)}`, 'onenote_flow=forged')).status, 400, 'wrong cookie');
  assert.equal(tokenRequests.length, 0, 'nothing is exchanged for a bad state');
  assert.equal((await callback(`code=c&state=${encodeURIComponent(state)}`, cookie)).status, 302);
  assert.equal((await callback(`code=c&state=${encodeURIComponent(state)}`, cookie)).status, 400, 'a state works once');
  // Another user's flow cookie doesn't fit my state.
  const mine = await begin(me);
  const theirs = await begin(other);
  assert.equal((await callback(`code=c&state=${encodeURIComponent(mine.state)}`, theirs.cookie)).status, 400);
});

test('connections and jobs belong to the user who signed in', async () => {
  const conn = await connect(me);
  assert.equal((await app.call('GET', `/import/onenote/connections/${conn}/notebooks`, other.token)).status, 404);
  const mine = await app.call('GET', `/import/onenote/connections/${conn}/notebooks`, me.token);
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.data.notebooks, [{ id: '0-NB1!1', name: 'Work' }, { id: '0-NB2!2', name: 'Recipes' }]);
  assert.equal((await app.call('POST', `/import/onenote/connections/${conn}/import`, other.token, { notebookIds: ['0-NB1!1'] })).status, 404);
  // A viewer can't import into the workspace.
  await app.call('POST', `/workspaces/${me.wsId}/members`, me.token, { email: other.user.email, role: 'viewer' });
  assert.equal((await app.call('POST', '/import/onenote/start', other.token, { workspaceId: me.wsId })).status, 403);
});

test('import: hierarchy, to-dos → tasks, image + attachment → files, malicious HTML sanitised, 429 retried', async () => {
  const { db } = await import('../server/db.ts');
  const { FILES_DIR } = await import('../server/config.ts');
  const conn = await connect();
  throttle.set('/me/onenote/pages/0-PG2!101/content', 2); // Graph throttles this page twice
  let release!: () => void;
  hold = new Promise((r) => (release = r));
  const start = await app.call('POST', `/import/onenote/connections/${conn}/import`, me.token, { notebookIds: ['0-NB1!1'] });
  assert.equal(start.status, 202, JSON.stringify(start.data));
  // One import at a time, server-wide.
  const second = await app.call('POST', `/import/onenote/connections/${await connect(other)}/import`, other.token, { notebookIds: ['0-NB1!1'] });
  assert.equal(second.status, 429);
  assert.ok(second.data.error);
  hold = null;
  release();
  const job = await waitForJob(start.data.id);
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.deepEqual(job.notebooks, { total: 1, done: 1 });
  assert.deepEqual(job.pages, { total: 3, done: 3 });
  assert.equal(job.images, 1);
  assert.equal(job.attachments, 1);
  assert.equal(job.tasks, 3);
  assert.ok(job.warnings.some((w: string) => /Secret.*password-protected/.test(w)), JSON.stringify(job.warnings));

  // 429 + Retry-After: waited 3 s twice, then succeeded.
  assert.deepEqual(sleeps, [3000, 3000]);
  // The token only ever went to Graph (never to evil.example from the page HTML).
  assert.ok(calls.every((c) => c.url.startsWith('https://graph.microsoft.com/v1.0/') || c.url.startsWith('https://login.microsoftonline.com/')));
  // The connection (and its tokens) is gone once the job ends.
  assert.equal((await app.call('GET', `/import/onenote/connections/${conn}/notebooks`, me.token)).status, 404);

  // Hierarchy: a private notebook, section groups flattened into "Group / Section", pages in OneNote order.
  const [nb] = db.prepare("SELECT * FROM notebooks WHERE workspace_id = ? AND name = 'Work'").all(me.wsId) as Record<string, string>[];
  assert.equal(nb.visibility, 'private');
  assert.equal(nb.created_by, me.user.id);
  assert.deepEqual(job.imported, [{ id: nb.id, name: 'Work' }]);
  const sections = db.prepare('SELECT id, name FROM sections WHERE notebook_id = ? ORDER BY position').all(nb.id) as { id: string; name: string }[];
  assert.deepEqual(sections.map((s) => s.name), ['Meetings', 'Projects / Alpha']);
  const pages = (sid: string) => db.prepare('SELECT * FROM pages WHERE section_id = ? ORDER BY position').all(sid) as Record<string, unknown>[];
  assert.deepEqual(pages(sections[0].id).map((p) => p.title), ['Weekly sync', 'Follow-ups']);
  const docOf = (p: Record<string, unknown>) => {
    const d = new Y.Doc();
    Y.applyUpdate(d, new Uint8Array(p.ydoc as Buffer));
    return d.getXmlFragment('default').toString();
  };

  // Content: headings, marks, links, lists, a table.
  const weekly = pages(sections[0].id)[0];
  const xml = docOf(weekly);
  assert.match(xml, /<heading level="1">Agenda &amp; notes<\/heading>|<heading level="1">Agenda & notes<\/heading>/);
  assert.match(xml, /<bold>Q4 plan<\/bold>/);
  assert.match(xml, /<italic>hiring<\/italic>/);
  assert.match(xml, /<bulletList><listItem><paragraph>Budget approved<\/paragraph><\/listItem><listItem><paragraph>Launch moved<hardBreak><\/hardBreak>to December/i);
  assert.match(xml, /<orderedList[^>]*><listItem><paragraph>First/i);
  assert.match(xml, /<table><tableRow><tableCell[^>]*><paragraph>Owner<\/paragraph>/i);
  assert.match(String(weekly.text), /Q4 plan/, 'indexed for search');
  assert.ok((db.prepare('SELECT 1 FROM pages_fts WHERE page_id = ?').get(weekly.id)), 'in the search index');

  // To-dos → real tasks (open and done) on the page, linked by taskRef.
  const tasks = db.prepare('SELECT * FROM tasks WHERE page_id = ? ORDER BY title').all(weekly.id) as Record<string, string>[];
  assert.deepEqual(tasks.map((t) => [t.title, t.status]), [['Book the room', 'done'], ['Send the minutes', 'open']]);
  for (const t of tasks) assert.match(xml, new RegExp(`<taskRef taskId="${t.id}">`, 'i'));
  const followUps = pages(sections[0].id)[1];
  const vendor = db.prepare('SELECT * FROM tasks WHERE page_id = ?').get(followUps.id) as Record<string, string>;
  assert.equal(vendor.title, 'Call the vendor');
  const dashboard = await app.call('GET', `/workspaces/${me.wsId}/tasks`, me.token);
  assert.ok(dashboard.data.some((t: { title: string }) => t.title === 'Send the minutes'), 'on the Tasks dashboard');

  // Image and attachment: downloaded through Graph, stored under fresh ids with allow-listed extensions.
  const files = db.prepare('SELECT * FROM files WHERE page_id = ? ORDER BY ext').all(weekly.id) as Record<string, string | number>[];
  assert.deepEqual(files.map((f) => [f.ext, f.mime, f.name]), [['.pdf', 'application/pdf', 'Q4 plan.pdf'], ['.png', 'image/png', 'image.png']]);
  for (const f of files) assert.ok(fs.existsSync(path.join(FILES_DIR, `${f.id}${f.ext}`)));
  const png = files.find((f) => f.ext === '.png')!;
  assert.match(xml, new RegExp(`<image alt="Whiteboard photo" src="/uploads/${png.id}.png"`, 'i'));
  const pdf = files.find((f) => f.ext === '.pdf')!;
  assert.match(xml, new RegExp(`<fileAttachment mime="application/pdf" name="Q4 plan.pdf" size="${pdf.size}" url="/uploads/${pdf.id}.pdf"`, 'i'));
  assert.doesNotMatch(xml, /graph\.microsoft\.com|onenote-res:|onenote-todo:/);

  // Malicious HTML: no scripts, handlers, javascript:/data: links or unsafe images survive.
  const evil = docOf(pages(sections[1].id)[0]);
  assert.doesNotMatch(evil, /script|alert\('(inline|svg|body|click|onerror|img)'|onerror|onclick|onload|onmouseover|javascript|data:text|iframe|password|inside iframe/i);
  assert.match(evil, /Click here or there or this\./, 'unsafe links lose the link, the text stays');
  assert.match(evil, /<link [^>]*href="https:\/\/example.org\/ok"[^>]*>link<\/link>/i);
  assert.match(evil, /&lt;3 escaped text stays text|<3 escaped text stays text/);
  assert.doesNotMatch(evil, /payload\.exe/, 'attachments that are not OneNote resources are dropped');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM files WHERE page_id = ?').get(pages(sections[1].id)[0].id) as { n: number }).n, 0);
});

test('retryDelay honours Retry-After (seconds or a date) and falls back to backoff', () => {
  assert.equal(on.retryDelay('7', 0), 7);
  assert.equal(on.retryDelay(null, 3), 8);
  assert.equal(on.retryDelay('junk', 0), 1);
  assert.equal(on.retryDelay('100000', 0), 120, 'capped');
  const inTen = new Date(Date.now() + 10_000).toUTCString();
  assert.ok(Math.abs(on.retryDelay(inTen, 0) - 10) <= 1);
});

test('Graph throttling past the retry budget fails the page with a warning, not the import', async () => {
  const conn = await connect();
  throttle.set('/me/onenote/pages/0-PG3!200/content', 100);
  const start = await app.call('POST', `/import/onenote/connections/${conn}/import`, me.token, { notebookIds: ['0-NB1!1'] });
  const job = await waitForJob(start.data.id);
  assert.equal(job.status, 'done');
  assert.equal(sleeps.length, on.MAX_TRIES - 1);
  assert.ok(job.warnings.some((w: string) => /Pasted from the web.*429/.test(w)), JSON.stringify(job.warnings));
});
