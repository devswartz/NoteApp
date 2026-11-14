// Notes under a task, server side (server/taskNotes.ts): subtask parents follow where a task block sits in its page,
// "From the note" for the task panel, Markdown export, and page copies that keep notes.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { startTestApp, type TestApp, type TestUser } from './helpers/app.ts';
import { collabClient, synced, waitFor, type CollabClient } from './helpers/collab.ts';

let app: TestApp;
const open: CollabClient[] = [];
before(async () => {
  app = await startTestApp();
});
after(async () => {
  for (const c of open) c.destroy();
  await app.close();
});

const el = (name: string, attrs: Record<string, unknown> = {}, kids: (Y.XmlElement | Y.XmlText)[] = []) => {
  const e = new Y.XmlElement(name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v as never);
  if (kids.length) e.insert(0, kids);
  return e;
};
const para = (t: string) => el('paragraph', {}, [new Y.XmlText(t)]);
const bullets = (...items: string[]) => el('bulletList', {}, items.map((t) => el('listItem', {}, [para(t)])));
const checks = (...items: [string, boolean][]) => el('taskList', {}, items.map(([t, c]) => el('taskItem', { checked: c }, [para(t)])));
const taskRef = (id: string, kids: Y.XmlElement[] = []) => el('taskRef', { taskId: id }, kids);

async function setup(name: string) {
  const u = await app.signUp(name);
  const nb = (await app.call('POST', `/workspaces/${u.wsId}/notebooks`, u.token, { name: 'Work' })).data;
  const pageId = (await app.call('POST', `/sections/${nb.sectionId}/pages`, u.token, { title: 'Notes page' })).data.id as string;
  const mk = async (title: string) => (await app.call('POST', `/workspaces/${u.wsId}/tasks`, u.token, { title, pageId })).data as { id: string };
  return { u, pageId, sectionId: nb.sectionId as string, mk };
}
const taskOf = async (u: TestUser, id: string) =>
  ((await app.call('GET', `/workspaces/${u.wsId}/tasks`, u.token)).data as { id: string; parentId: string | null; pageId: string | null }[]).find((t) => t.id === id);

async function eventually(check: () => Promise<boolean>, what: string, ms = 5000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('taskPlaces: each task block with the outermost task around it (subtasks are one level deep)', async () => {
  const { taskPlaces } = await import('../server/taskNotes.ts');
  const doc = new Y.Doc();
  doc.getXmlFragment('default').insert(0, [taskRef('a', [bullets('x'), checks(['c1', true], ['c2', false]), taskRef('b', [taskRef('c', [checks(['deep', true])])])]), para('p'), taskRef('d')]);
  const places = taskPlaces(doc);
  assert.deepEqual(
    places.map((p) => p.checklist),
    [{ done: 1, total: 2 }, { done: 0, total: 0 }, { done: 1, total: 1 }, { done: 0, total: 0 }],
    'each task counts its own checklist, not its subtasks’',
  );
  assert.deepEqual(places.map(({ id, parent, depth }) => ({ id, parent, depth })), [
    { id: 'a', parent: null, depth: 0 },
    { id: 'b', parent: 'a', depth: 1 },
    { id: 'c', parent: 'a', depth: 2 },
    { id: 'd', parent: null, depth: 0 },
  ]);
});

test('a task block put in another task’s notes becomes its subtask on save, and a top-level task again when moved out', async () => {
  const { u, pageId, mk } = await setup('Placer');
  const t = await mk('Parent');
  const s = await mk('Child');
  const c = collabClient(app, pageId, u.token);
  open.push(c);
  await synced(c);
  const frag = c.doc.getXmlFragment('default');
  frag.insert(frag.length, [taskRef(t.id, [bullets('a note'), taskRef(s.id)])]);
  await eventually(async () => (await taskOf(u, s.id))?.parentId === t.id, 'subtask parent set');
  assert.equal((await taskOf(u, s.id))?.pageId, pageId, 'still on the page');
  // Lift it out: delete it inside, put it at the top level.
  const parentEl = frag.toArray().find((n) => n instanceof Y.XmlElement && n.getAttribute('taskId') === t.id) as Y.XmlElement;
  c.doc.transact(() => {
    parentEl.delete(1, 1);
    frag.insert(frag.length, [taskRef(s.id)]);
  });
  await eventually(async () => (await taskOf(u, s.id))?.parentId === null, 'parent cleared');
  assert.equal((await taskOf(u, s.id))?.pageId, pageId);
});

test('a task with subtasks of its own stays top-level when tabbed into another task (its subtasks move up)', async () => {
  const { u, pageId, mk } = await setup('Nester');
  const a = await mk('A');
  const b = await mk('B');
  const sub = (await app.call('POST', `/workspaces/${u.wsId}/tasks`, u.token, { title: 'B sub', parentId: b.id })).data as { id: string };
  const c = collabClient(app, pageId, u.token);
  open.push(c);
  await synced(c);
  // B (with its subtask written in its notes) goes into A's notes: both become A's subtasks.
  c.doc.getXmlFragment('default').insert(0, [taskRef(a.id, [taskRef(b.id, [taskRef(sub.id)])])]);
  await eventually(async () => (await taskOf(u, b.id))?.parentId === a.id && (await taskOf(u, sub.id))?.parentId === a.id, 'both under A');
});

test('From the note: the notes under a task as Markdown, checklists with their state; nothing for a task without notes', async () => {
  const { u, pageId, mk } = await setup('Reader');
  const t = await mk('Plan trip');
  const sub = await mk('Book hotel');
  const bare = await mk('Bare');
  const c = collabClient(app, pageId, u.token);
  open.push(c);
  await synced(c);
  c.doc.getXmlFragment('default').insert(0, [
    taskRef(t.id, [bullets('flights', 'trains'), checks(['passport', true], ['adapter', false]), taskRef(sub.id, [para('near the station')])]),
    taskRef(bare.id),
  ]);
  await eventually(async () => (await app.call('GET', `/tasks/${t.id}/notes`, u.token)).data.markdown !== '', 'notes readable');
  const md = (await app.call('GET', `/tasks/${t.id}/notes`, u.token)).data.markdown as string;
  // The subtask (and its notes) are left out: the panel lists subtasks on their own.
  assert.equal(md, ['- flights', '- trains', '- [x] passport', '- [ ] adapter'].join('\n'));
  assert.equal((await app.call('GET', `/tasks/${bare.id}/notes`, u.token)).data.markdown, '');
  // The checklist's count is on the task for the Tasks views; its items are never tasks.
  await eventually(async () => JSON.stringify((await taskOf(u, t.id) as { checklist?: unknown })?.checklist) === '{"done":1,"total":2}', 'checklist count');
  const all = (await app.call('GET', `/workspaces/${u.wsId}/tasks`, u.token)).data as { title: string; pageId: string | null; checklist?: unknown }[];
  assert.deepEqual(all.filter((x) => x.pageId === pageId).map((x) => x.title).sort(), ['Bare', 'Book hotel', 'Plan trip'], 'no task for a checklist item');
  assert.equal(all.find((x) => x.title === 'Bare')?.checklist, null);
  const stranger = await app.signUp('Nosy');
  assert.equal((await app.call('GET', `/tasks/${t.id}/notes`, stranger.token)).status, 404);
});

test('Markdown export: a task line, then its notes indented under it (kept even when the task can’t be shown)', async () => {
  const { toMarkdown } = await import('../server/markdown.ts');
  const doc = new Y.Doc();
  const frag = doc.getXmlFragment('default');
  frag.insert(0, [taskRef('t1', [bullets('a', 'b'), checks(['c', true])]), taskRef('gone', [para('still here')])]);
  const md = toMarkdown('P', frag, (id) => (id === 't1' ? { title: 'Do it', done: false } : undefined));
  assert.equal(md, '# P\n\n- [ ] Do it\n  - a\n  - b\n  - [x] c\nstill here\n');
});

test('copying a page keeps notes: subtasks point at their task’s copy; a task not copied leaves its notes', async () => {
  const { u, pageId, sectionId, mk } = await setup('Copier');
  const t = await mk('Top');
  const s = await mk('Sub');
  const other = (await app.call('POST', `/workspaces/${u.wsId}/tasks`, u.token, { title: 'Elsewhere' })).data as { id: string };
  const c = collabClient(app, pageId, u.token);
  open.push(c);
  await synced(c);
  c.doc.getXmlFragment('default').insert(0, [taskRef(t.id, [taskRef(s.id)]), taskRef(other.id, [para('note of a foreign task')])]);
  await eventually(async () => (await taskOf(u, s.id))?.parentId === t.id, 'subtask set');
  // The foreign task was attached to this page by the save; make it someone else's page's again for the copy rule.
  const { db } = await import('../server/db.ts');
  db.prepare('UPDATE tasks SET page_id = NULL WHERE id = ?').run(other.id);
  const r = await app.call('POST', `/pages/${pageId}/copy`, u.token, {});
  assert.equal(r.status, 200);
  const copy = r.data.id as string;
  const row = db.prepare('SELECT ydoc FROM pages WHERE id = ?').get(copy) as { ydoc: Buffer };
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(row.ydoc));
  const { taskPlaces } = await import('../server/taskNotes.ts');
  const places = taskPlaces(doc);
  assert.equal(places.length, 2, 'top and sub copied; the foreign task dropped');
  const tasks = db.prepare('SELECT id, parent_id FROM tasks WHERE page_id = ?').all(copy) as { id: string; parent_id: string | null }[];
  const top = places.find((p) => !p.parent)!;
  const subCopy = tasks.find((x) => x.id === places.find((p) => p.parent)!.id)!;
  assert.equal(subCopy.parent_id, top.id);
  const { extractPage } = await import('../server/collab.ts');
  assert.match(extractPage(doc).text, /note of a foreign task/);
  void sectionId;
  void waitFor;
});
