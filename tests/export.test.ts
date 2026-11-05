import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { startTestApp, type TestApp } from './helpers/app.ts';

let app: TestApp;
before(async () => {
  app = await startTestApp();
});
after(() => app.close());

async function raw(method: string, url: string, token: string, body?: Buffer, headers: Record<string, string> = {}) {
  const res = await fetch(`${app.origin}/api${url}`, { method, headers: { authorization: `Bearer ${token}`, ...headers }, body: body ? new Uint8Array(body) : undefined });
  return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
}

test('export → import round-trip keeps the tree, page content, tasks and files', async () => {
  const owner = await app.signUp('Olive');
  const member = await app.signUp('Mel');
  await app.call('POST', `/workspaces/${owner.wsId}/members`, owner.token, { email: member.user.email, role: 'member' });
  // Member's private notebook must not be exported by the owner.
  await app.call('POST', `/workspaces/${owner.wsId}/notebooks`, member.token, { name: 'Mel secret', visibility: 'private' });

  const nb = await app.call('POST', `/workspaces/${owner.wsId}/notebooks`, owner.token, { name: 'Projects' });
  const pageId = (await app.call('POST', `/sections/${nb.data.sectionId}/pages`, owner.token, { title: 'Launch plan' })).data.id as string;
  const task = (await app.call('POST', `/workspaces/${owner.wsId}/tasks`, owner.token, { title: 'Book venue', pageId, assigneeId: owner.user.id, dueDate: '2026-12-01' })).data;
  const upload = await raw('POST', `/workspaces/${owner.wsId}/files?pageId=${pageId}`, owner.token, Buffer.from('PNGDATA'), {
    'content-type': 'application/octet-stream',
    'x-filename': 'pic.png',
  });
  assert.equal(upload.status, 200);
  const file = JSON.parse(upload.buf.toString());

  // Page content with a heading, bold text and the embedded task.
  const { seedPageDoc } = await import('../server/collab.ts');
  seedPageDoc(pageId, (frag) => {
    const h = new Y.XmlElement('heading');
    h.setAttribute('level', '2' as never);
    h.insert(0, [new Y.XmlText('Goals')]);
    const p = new Y.XmlElement('paragraph');
    const t = new Y.XmlText();
    t.insert(0, 'Ship it ');
    t.insert(8, 'fast', { bold: {} });
    p.insert(0, [t]);
    const ref = new Y.XmlElement('taskRef');
    ref.setAttribute('taskId', task.id);
    frag.insert(0, [h, p, ref]);
  });

  assert.equal((await raw('GET', `/workspaces/${owner.wsId}/export`, member.token)).status, 403, 'members cannot export');
  const exp = await raw('GET', `/workspaces/${owner.wsId}/export`, owner.token);
  assert.equal(exp.status, 200);
  assert.equal(exp.headers.get('content-type'), 'application/zip');

  const { readZip } = await import('../server/zip.ts');
  const entries = readZip(exp.buf);
  const names = entries.map((e) => e.name);
  assert.ok(names.includes('workspace.json'));
  assert.ok(!names.some((n) => n.includes('Mel secret')), 'private notebook of another user not exported');
  const md = entries.find((e) => e.name === 'pages/Projects/General/Launch plan.md')!.data.toString();
  assert.match(md, /^# Launch plan/);
  assert.match(md, /## Goals/);
  assert.match(md, /Ship it \*\*fast\*\*/);
  assert.match(md, /- \[ \] Book venue \(due 2026-12-01\)/);
  assert.ok(names.includes(`files/${file.id}${file.url.slice(file.url.lastIndexOf('.'))}`) || names.some((n) => n.startsWith(`files/${file.id}`)));

  // Import as a different user.
  const other = await app.signUp('Ivy');
  const imp = await raw('POST', '/workspaces/import', other.token, exp.buf, { 'content-type': 'application/zip' });
  assert.equal(imp.status, 200, imp.buf.toString());
  const { workspaceId } = JSON.parse(imp.buf.toString());
  const tree = await app.call('GET', `/workspaces/${workspaceId}/tree`, other.token);
  assert.ok(tree.data.notebooks.some((n: { name: string }) => n.name === 'Projects'));
  const newPage = tree.data.pages.find((p: { title: string }) => p.title === 'Launch plan');
  assert.ok(newPage);
  assert.notEqual(newPage.id, pageId, 'fresh ids');
  const tasks = (await app.call('GET', `/workspaces/${workspaceId}/tasks`, other.token)).data as { id: string; title: string; pageId: string; assigneeId: string | null }[];
  const newTask = tasks.find((t) => t.title === 'Book venue')!;
  assert.notEqual(newTask.id, task.id);
  assert.equal(newTask.pageId, newPage.id);
  assert.equal(newTask.assigneeId, null, 'assignee from another account is dropped');

  // The imported page document points at the new task id.
  const { db } = await import('../server/db.ts');
  const row = db.prepare('SELECT ydoc FROM pages WHERE id = ?').get(newPage.id) as { ydoc: Buffer };
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(row.ydoc));
  const { extractDoc } = await import('../server/collab.ts');
  assert.deepEqual([...extractDoc(doc.getXmlFragment('default')).taskIds], [newTask.id]);
  const search = await app.call('GET', `/workspaces/${workspaceId}/search?q=Goals`, other.token);
  assert.ok(search.data.pages.length >= 1, 'imported pages are searchable');
});

test('import rejects garbage', async () => {
  const u = await app.signUp('Gary');
  const r = await raw('POST', '/workspaces/import', u.token, Buffer.from('definitely not a zip file'), { 'content-type': 'application/zip' });
  assert.equal(r.status, 400);
});
