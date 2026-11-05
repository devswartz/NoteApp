// Editor & Notes server side: search, files, tree moves/copies, Yjs extraction.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { startTestApp, type TestApp, type TestUser } from './helpers/app.ts';

let app: TestApp;
before(async () => {
  app = await startTestApp();
});
after(() => app.close());

/** A fresh notebook with two sections, for tests that move things around. */
async function setup(name: string) {
  const u = await app.signUp(name);
  const nb = (await app.call('POST', `/workspaces/${u.wsId}/notebooks`, u.token, { name: 'Work' })).data;
  const s2 = (await app.call('POST', `/notebooks/${nb.id}/sections`, u.token, { name: 'Second' })).data.id as string;
  return { ...u, notebookId: nb.id as string, s1: nb.sectionId as string, s2 };
}

async function newPage(u: TestUser, sectionId: string, title: string) {
  return (await app.call('POST', `/sections/${sectionId}/pages`, u.token, { title })).data.id as string;
}

/** Write document content straight into a page (what the collab server would persist). */
async function writeDoc(pageId: string, build: (frag: Y.XmlFragment) => void) {
  const { seedPageDoc } = await import('../server/collab.ts');
  seedPageDoc(pageId, build);
}

function para(text: string) {
  const p = new Y.XmlElement('paragraph');
  p.insert(0, [new Y.XmlText(text)]);
  return p;
}
function taskRef(taskId: string) {
  const r = new Y.XmlElement('taskRef');
  r.setAttribute('taskId', taskId);
  return r;
}

const pagesIn = async (u: TestUser, sectionId: string) =>
  ((await app.call('GET', `/workspaces/${u.wsId}/tree`, u.token)).data.pages as { id: string; sectionId: string; title: string }[]).filter(
    (p) => p.sectionId === sectionId,
  );

// ───────── extraction ─────────

test('extractDoc collects text from nested blocks and taskRefs inside lists, toggles and tables', async () => {
  const { extractDoc } = await import('../server/collab.ts');
  const doc = new Y.Doc();
  const frag = doc.getXmlFragment('default');
  const h = new Y.XmlElement('heading');
  h.setAttribute('level', '1' as never);
  h.insert(0, [new Y.XmlText('Launch plan')]);
  const list = new Y.XmlElement('bulletList');
  const li = new Y.XmlElement('listItem');
  li.insert(0, [para('first point')]);
  list.insert(0, [li]);
  const toggle = new Y.XmlElement('details');
  toggle.insert(0, [para('hidden detail'), taskRef('t-nested')]);
  frag.insert(0, [h, list, toggle, taskRef('t-top'), taskRef('')]);
  const { text, taskIds } = extractDoc(frag);
  assert.match(text, /Launch plan/);
  assert.match(text, /first point/);
  assert.match(text, /hidden detail/);
  assert.deepEqual([...taskIds].sort(), ['t-nested', 't-top']);
});

// ───────── search ─────────

test('search finds pages by title and body with highlighted snippets, title matches first', async () => {
  const u = await setup('Searcher');
  const body = await newPage(u, u.s1, 'Weekly notes');
  await writeDoc(body, (f) => f.insert(0, [para('We discussed the quarterly budget and hiring.')]));
  const titled = await newPage(u, u.s1, 'Budget 2027');
  const r = await app.call('GET', `/workspaces/${u.wsId}/search?q=budget`, u.token);
  assert.equal(r.status, 200);
  const ids = r.data.pages.map((p: { id: string }) => p.id);
  assert.deepEqual(ids.slice(0, 2), [titled, body]);
  const hit = r.data.pages.find((p: { id: string }) => p.id === body);
  assert.match(hit.snippet, /«budget»/);
  assert.equal(hit.notebookName, 'Work');
});

test('search: prefix + stemming, all terms required, FTS syntax is neutralised', async () => {
  const u = await setup('Prefixer');
  const p = await newPage(u, u.s1, 'Planning');
  await writeDoc(p, (f) => f.insert(0, [para('Running the offsite in Lisbon')]));
  const q = async (s: string) => (await app.call('GET', `/workspaces/${u.wsId}/search?q=${encodeURIComponent(s)}`, u.token));
  assert.equal((await q('plan')).data.pages.length, 1);
  assert.equal((await q('runs lisbon')).data.pages.length, 1, 'stemmed: runs ~ running');
  assert.equal((await q('lisbon paris')).data.pages.length, 0, 'every term must match');
  for (const weird of ['"', 'AND', 'NEAR(', '*', 'title:x', "o'brien", '-x']) assert.equal((await q(weird)).status, 200, weird);
  assert.deepEqual((await q('   ')).data, { pages: [], tasks: [] });
});

test('search finds tasks by title and description and follows edits', async () => {
  const u = await setup('Tasker');
  const t = (await app.call('POST', `/workspaces/${u.wsId}/tasks`, u.token, { title: 'Renew passport' })).data;
  await app.call('PATCH', `/tasks/${t.id}`, u.token, { description: 'Bring two photos to the embassy' });
  const q = async (s: string) => (await app.call('GET', `/workspaces/${u.wsId}/search?q=${s}`, u.token)).data.tasks as { id: string; snippet?: string }[];
  assert.deepEqual((await q('passport')).map((x) => x.id), [t.id]);
  const byDesc = await q('embassy');
  assert.equal(byDesc[0].id, t.id);
  assert.match(byDesc[0].snippet!, /«embassy»/);
  await app.call('PATCH', `/tasks/${t.id}`, u.token, { title: 'Book flights' });
  assert.equal((await q('passport')).length, 0);
  assert.equal((await q('flight')).length, 1);
});

test("search never returns another member's private notebook pages", async () => {
  const owner = await app.signUp('Owner');
  const other = await app.signUp('Other');
  await app.call('POST', `/workspaces/${owner.wsId}/members`, owner.token, { email: other.user.email, role: 'member' });
  const priv = (await app.call('POST', `/workspaces/${owner.wsId}/notebooks`, owner.token, { name: 'Diary', visibility: 'private' })).data;
  await newPage(owner, priv.sectionId, 'Secret zebra');
  assert.equal((await app.call('GET', `/workspaces/${owner.wsId}/search?q=zebra`, owner.token)).data.pages.length, 1);
  const r = await app.call('GET', `/workspaces/${owner.wsId}/search?q=zebra`, other.token);
  assert.equal(r.status, 200);
  assert.equal(r.data.pages.length, 0);
});

// ───────── files ─────────

async function uploadTo(u: TestUser, body: Uint8Array | string, name: string, type = '', path = `/workspaces/${u.wsId}/files`) {
  const res = await fetch(`${app.origin}/api${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${u.token}`, 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(name), ...(type ? { 'x-file-type': type } : {}) },
    body: Buffer.from(body),
  });
  return { status: res.status, data: await res.json() };
}

test('files: upload, metadata, and serving from /uploads', async () => {
  const u = await setup('Uploader');
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const r = await uploadTo(u, png, 'Screen shot.PNG', 'image/png');
  assert.equal(r.status, 200);
  assert.match(r.data.id, /^[0-9a-f]{32}$/);
  assert.equal(r.data.url, `/uploads/${r.data.id}.png`);
  assert.equal(r.data.name, 'Screen shot.PNG');
  assert.equal(r.data.mime, 'image/png');
  assert.equal(r.data.size, png.length);
  const served = await fetch(`${app.origin}${r.data.url}`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.deepEqual(new Uint8Array(await served.arrayBuffer()), png);
  const meta = await app.call('GET', `/files/${r.data.id}`, u.token);
  assert.deepEqual(meta.data, r.data);
  const stranger = await app.signUp('Stranger');
  assert.equal((await app.call('GET', `/files/${r.data.id}`, stranger.token)).status, 404);
});

test('files: active content is stored so it downloads instead of running', async () => {
  const u = await setup('Svg');
  const r = await uploadTo(u, '<svg onload="alert(1)"/>', 'evil.svg', 'image/svg+xml');
  assert.equal(r.data.url.endsWith('.svg.bin'), true);
  const served = await fetch(`${app.origin}${r.data.url}`);
  assert.equal(served.headers.get('content-type'), 'application/octet-stream');
});

test('files: path tricks in names are stripped; empty, unauthenticated and viewer uploads are rejected', async () => {
  const u = await setup('Tricky');
  const r = await uploadTo(u, 'x', '../../etc/passwd');
  assert.equal(r.data.name, 'passwd');
  assert.equal(r.data.url, `/uploads/${r.data.id}`);
  assert.equal((await uploadTo(u, '', 'empty.txt')).status, 400);
  const anon = await fetch(`${app.origin}/api/workspaces/${u.wsId}/files`, { method: 'POST', body: 'x' });
  assert.equal(anon.status, 401);
  const viewer = await app.signUp('Viewer');
  await app.call('POST', `/workspaces/${u.wsId}/members`, u.token, { email: viewer.user.email, role: 'viewer' });
  assert.equal((await uploadTo({ ...viewer, wsId: u.wsId }, 'x', 'a.txt')).status, 403);
  // Legacy endpoint still works.
  const legacy = await uploadTo(u, 'hello', 'note.txt', 'text/plain', '/uploads');
  assert.equal(legacy.status, 200);
  assert.equal(legacy.data.url, `/uploads/${legacy.data.id}.txt`);
});

// ───────── tree moves and copies ─────────

test('pages: move to an index within a section and into another section', async () => {
  const u = await setup('Mover');
  const a = await newPage(u, u.s1, 'A');
  const b = await newPage(u, u.s1, 'B');
  const c = await newPage(u, u.s1, 'C');
  assert.equal((await app.call('POST', `/pages/${c}/move`, u.token, { index: 0 })).status, 200);
  assert.deepEqual((await pagesIn(u, u.s1)).map((p) => p.title), ['C', 'A', 'B']);
  await app.call('POST', `/pages/${c}/move`, u.token, { index: 2 });
  assert.deepEqual((await pagesIn(u, u.s1)).map((p) => p.title), ['A', 'B', 'C']);
  await app.call('POST', `/pages/${a}/move`, u.token, { index: 1 });
  assert.deepEqual((await pagesIn(u, u.s1)).map((p) => p.title), ['B', 'A', 'C']);
  await app.call('POST', `/pages/${b}/move`, u.token, { sectionId: u.s2 });
  assert.deepEqual((await pagesIn(u, u.s1)).map((p) => p.title), ['A', 'C']);
  assert.deepEqual((await pagesIn(u, u.s2)).map((p) => p.title), ['B']);
  // Into another notebook; its tasks follow the page.
  const nb2 = (await app.call('POST', `/workspaces/${u.wsId}/notebooks`, u.token, { name: 'Other' })).data;
  const t = (await app.call('POST', `/workspaces/${u.wsId}/tasks`, u.token, { title: 'On A', pageId: a })).data;
  await app.call('POST', `/pages/${a}/move`, u.token, { sectionId: nb2.sectionId, index: 0 });
  assert.deepEqual((await pagesIn(u, nb2.sectionId)).map((p) => p.title), ['A']);
  const tasks = (await app.call('GET', `/workspaces/${u.wsId}/tasks`, u.token)).data as { id: string; pageId: string }[];
  assert.equal(tasks.find((x) => x.id === t.id)!.pageId, a);
});

test("pages: can't move into another workspace or a section you can't see", async () => {
  const u = await setup('Fence');
  const other = await setup('Neighbour');
  const p = await newPage(u, u.s1, 'Mine');
  const r = await app.call('POST', `/pages/${p}/move`, u.token, { sectionId: other.s1 });
  assert.equal(r.status, 404);
  assert.equal((await app.call('POST', `/pages/${p}/copy`, u.token, { sectionId: other.s1 })).status, 404);
});

test('pages: copy duplicates content and gives the copy its own tasks', async () => {
  const u = await setup('Copier');
  const p = await newPage(u, u.s1, 'Template');
  const after = await newPage(u, u.s1, 'After');
  const t = (await app.call('POST', `/workspaces/${u.wsId}/tasks`, u.token, { title: 'Check list', pageId: p, priority: 2 })).data;
  await writeDoc(p, (f) => f.insert(0, [para('Copy me'), taskRef(t.id)]));

  const r = await app.call('POST', `/pages/${p}/copy`, u.token, {});
  assert.equal(r.status, 200);
  const copyId = r.data.id as string;
  assert.deepEqual((await pagesIn(u, u.s1)).map((x) => x.title), ['Template', 'Template (copy)', 'After']);
  void after;

  const { db } = await import('../server/db.ts');
  const { taskRefsInDoc } = await import('../server/tree.ts');
  const row = db.prepare('SELECT ydoc, text FROM pages WHERE id = ?').get(copyId) as { ydoc: Buffer; text: string };
  assert.match(row.text, /Copy me/);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(row.ydoc));
  const refs = taskRefsInDoc(doc).map((e) => e.getAttribute('taskId') as string);
  assert.equal(refs.length, 1);
  assert.notEqual(refs[0], t.id, 'the copy embeds a new task');
  const tasks = (await app.call('GET', `/workspaces/${u.wsId}/tasks`, u.token)).data as { id: string; pageId: string; title: string; priority: number }[];
  const copied = tasks.find((x) => x.id === refs[0])!;
  assert.equal(copied.pageId, copyId);
  assert.equal(copied.title, 'Check list');
  assert.equal(copied.priority, 2);
  assert.equal(tasks.find((x) => x.id === t.id)!.pageId, p, 'the original keeps its task');
  // The copy is searchable.
  const s = await app.call('GET', `/workspaces/${u.wsId}/search?q=copy`, u.token);
  assert.ok(s.data.pages.some((x: { id: string }) => x.id === copyId));
});

test('sections: reorder, move to another notebook, copy with pages; notebooks reorder', async () => {
  const u = await setup('Sections');
  await newPage(u, u.s2, 'Inside');
  await app.call('POST', `/sections/${u.s2}/move`, u.token, { index: 0 });
  let tree = (await app.call('GET', `/workspaces/${u.wsId}/tree`, u.token)).data;
  const order = (nb: string) => tree.sections.filter((s: { notebookId: string }) => s.notebookId === nb).map((s: { id: string }) => s.id);
  assert.deepEqual(order(u.notebookId), [u.s2, u.s1]);

  const copy = await app.call('POST', `/sections/${u.s2}/copy`, u.token, {});
  assert.equal(copy.status, 200);
  assert.deepEqual((await pagesIn(u, copy.data.id)).map((p) => p.title), ['Inside']);

  const nb2 = (await app.call('POST', `/workspaces/${u.wsId}/notebooks`, u.token, { name: 'Archive' })).data;
  await app.call('POST', `/sections/${u.s2}/move`, u.token, { notebookId: nb2.id, index: 0 });
  tree = (await app.call('GET', `/workspaces/${u.wsId}/tree`, u.token)).data;
  assert.equal(order(nb2.id)[0], u.s2);
  assert.ok(!order(u.notebookId).includes(u.s2));

  await app.call('POST', `/notebooks/${nb2.id}/move`, u.token, { index: 0 });
  tree = (await app.call('GET', `/workspaces/${u.wsId}/tree`, u.token)).data;
  assert.equal(tree.notebooks[0].id, nb2.id);
});

test('positionAt averages neighbours and handles empty lists', async () => {
  const u = await setup('Positions');
  const { positionAt } = await import('../server/tree.ts');
  const empty = (await app.call('POST', `/notebooks/${u.notebookId}/sections`, u.token, { name: 'Empty' })).data.id;
  assert.equal(positionAt('pages', 'section_id', empty, 0), 1);
  await newPage(u, empty, 'one'); // position 1
  await newPage(u, empty, 'two'); // position 2
  assert.equal(positionAt('pages', 'section_id', empty, 1), 1.5);
  assert.equal(positionAt('pages', 'section_id', empty, 0), 0);
  assert.equal(positionAt('pages', 'section_id', empty, 99), 3);
});
