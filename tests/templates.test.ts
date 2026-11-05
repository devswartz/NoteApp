// User templates: save a page as a template, list/rename/delete, and use one
// (new tasks, copied attachments). Authorization is also covered by tests/authz-audit.test.ts.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import WS from 'ws';
import { startTestApp, type TestApp, type TestUser } from './helpers/app.ts';

let app: TestApp;
let owner: TestUser, admin: TestUser, member: TestUser, viewer: TestUser, stranger: TestUser;
let filesDir: string;
let db: typeof import('../server/db.ts').db;
let ws: string;
let shared: { nb: string; sec: string; page: string };
let priv: { nb: string; sec: string; page: string };

before(async () => {
  app = await startTestApp();
  [owner, admin, member, viewer, stranger] = await Promise.all(['TOwner', 'TAdmin', 'TMember', 'TViewer', 'TStranger'].map((n) => app.signUp(n)));
  ({ FILES_DIR: filesDir } = await import('../server/config.ts'));
  ({ db } = await import('../server/db.ts'));
  ws = owner.wsId;
  for (const [u, role] of [[admin, 'admin'], [member, 'member'], [viewer, 'viewer']] as const)
    await app.call('POST', `/workspaces/${ws}/members`, owner.token, { email: u.user.email, role });
  const mk = async (visibility: 'shared' | 'private') => {
    const nb = (await app.call('POST', `/workspaces/${ws}/notebooks`, owner.token, { name: `NB ${visibility}`, visibility })).data.id;
    const sec = (await app.call('POST', `/notebooks/${nb}/sections`, owner.token, { name: 'S' })).data.id;
    const page = (await app.call('POST', `/sections/${sec}/pages`, owner.token, { title: 'P' })).data.id;
    return { nb, sec, page };
  };
  shared = await mk('shared');
  priv = await mk('private');
});
after(() => app.close());

const upload = async (token: string, wsId: string, pageId: string | null, body = 'hello bytes', name = 'note.txt') => {
  const r = await fetch(`${app.origin}/api/workspaces/${wsId}/files${pageId ? `?pageId=${pageId}` : ''}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream', 'x-filename': name },
    body,
  });
  return (await r.json()) as { id: string; url: string; name: string; mime: string; size: number };
};
const onDisk = (url: string) => fs.existsSync(path.join(filesDir, url.replace('/uploads/', '')));
const mkTask = async (user: TestUser, pageId: string | null, extra: Record<string, unknown> = {}) =>
  (await app.call('POST', `/workspaces/${ws}/tasks`, user.token, { title: 'Write spec', pageId, ...extra })).data.id as string;
const doc = (...content: unknown[]) => ({ type: 'doc', content });
const para = (t: string) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });
const ref = (taskId: string) => ({ type: 'taskRef', attrs: { taskId } });
const save = (user: TestUser, pageId: string, content: unknown, name = 'My template') =>
  app.call('POST', `/pages/${pageId}/templates`, user.token, { name, content });
const list = async (user: TestUser, wsId = ws) => (await app.call('GET', `/workspaces/${wsId}/templates`, user.token)).data as { id: string; name: string; visibility: string; taskCount: number; fileCount: number; canManage: boolean }[];
const taskRow = (id: string) => db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;

test('save, list, rename and delete', async () => {
  const r = await save(member, shared.page, doc(para('Hello')), '  Weekly review ');
  assert.equal(r.status, 200);
  assert.equal(r.data.name, 'Weekly review');
  assert.equal(r.data.visibility, 'workspace');
  assert.equal(r.data.createdBy, member.user.id);
  assert.equal(r.data.canManage, true);
  assert.equal('content' in r.data, false, 'list/save responses carry no content');
  for (const u of [owner, admin, member, viewer]) assert.ok((await list(u)).some((t) => t.id === r.data.id), 'visible to every member');
  assert.equal((await list(viewer)).find((t) => t.id === r.data.id)!.canManage, false);
  assert.equal((await list(admin)).find((t) => t.id === r.data.id)!.canManage, true);

  const ren = await app.call('PATCH', `/templates/${r.data.id}`, member.token, { name: 'Renamed', icon: '📋' });
  assert.equal(ren.status, 200);
  assert.equal(ren.data.name, 'Renamed');
  assert.equal(ren.data.icon, '📋');
  assert.equal((await app.call('PATCH', `/templates/${r.data.id}`, member.token, { name: '  ' })).status, 400);

  assert.equal((await app.call('DELETE', `/templates/${r.data.id}`, member.token)).status, 200);
  assert.ok(!(await list(owner)).some((t) => t.id === r.data.id));
  assert.equal((await app.call('DELETE', `/templates/${r.data.id}`, member.token)).status, 404);
});

test('who can do what', async () => {
  const content = doc(para('x'));
  assert.equal((await app.call('POST', `/pages/${shared.page}/templates`, undefined, { name: 'a', content })).status, 401);
  assert.equal((await app.call('GET', `/workspaces/${ws}/templates`)).status, 401);
  assert.equal((await save(stranger, shared.page, content)).status, 404);
  assert.equal((await app.call('GET', `/workspaces/${ws}/templates`, stranger.token)).status, 404);
  assert.equal((await save(viewer, shared.page, content)).status, 403);

  const t = (await save(member, shared.page, content, 'Mine')).data.id;
  // Stranger: nothing. Viewer: may list but not change or use. Another plain member can't rename someone else's.
  for (const [m, p, body] of [['PATCH', `/templates/${t}`, { name: 'x' }], ['DELETE', `/templates/${t}`, undefined], ['POST', `/templates/${t}/use`, { pageId: shared.page }]] as const)
    assert.equal((await app.call(m, p, stranger.token, body)).status, 404, `stranger ${m}`);
  assert.equal((await app.call('PATCH', `/templates/${t}`, viewer.token, { name: 'x' })).status, 403);
  assert.equal((await app.call('DELETE', `/templates/${t}`, viewer.token)).status, 403);
  assert.equal((await app.call('POST', `/templates/${t}/use`, viewer.token, { pageId: shared.page })).status, 403);
  const other = await app.signUp('TMember2');
  await app.call('POST', `/workspaces/${ws}/members`, owner.token, { email: other.user.email, role: 'member' });
  assert.equal((await app.call('PATCH', `/templates/${t}`, other.token, { name: 'x' })).status, 403);
  assert.equal((await app.call('DELETE', `/templates/${t}`, other.token)).status, 403);
  // Admins (and the owner) can manage anyone's workspace-visible template.
  assert.equal((await app.call('PATCH', `/templates/${t}`, admin.token, { name: 'By admin' })).status, 200);
  assert.equal((await app.call('DELETE', `/templates/${t}`, owner.token)).status, 200);
});

test('a template saved from a private page is visible to its creator only (and its files too)', async () => {
  // Another member can't even save from a page they can't see.
  assert.equal((await save(member, priv.page, doc(para('secret')))).status, 404);
  const file = await upload(owner.token, ws, priv.page, 'secret bytes');
  const t = await save(owner, priv.page, doc(para('Top secret'), { type: 'fileAttachment', attrs: { url: file.url, name: 'note.txt', size: 12, mime: 'text/plain' } }), 'Secret plan');
  assert.equal(t.status, 200);
  assert.equal(t.data.visibility, 'private');
  assert.deepEqual((await list(owner)).filter((x) => x.id === t.data.id).map((x) => x.visibility), ['private']);
  for (const u of [admin, member, viewer, stranger]) {
    const l = await app.call('GET', `/workspaces/${ws}/templates`, u.token);
    if (u === stranger) assert.equal(l.status, 404);
    else assert.ok(!(l.data as { id: string }[]).some((x) => x.id === t.data.id), 'private template not listed');
    assert.equal((await app.call('PATCH', `/templates/${t.data.id}`, u.token, { name: 'x' })).status, 404);
    assert.equal((await app.call('DELETE', `/templates/${t.data.id}`, u.token)).status, 404);
    assert.equal((await app.call('POST', `/templates/${t.data.id}/use`, u.token, { pageId: shared.page })).status, 404);
  }
  // The attachment copy's metadata follows the template's visibility.
  const copy = (db.prepare('SELECT id FROM files WHERE template_id = ?').get(t.data.id) as { id: string }).id;
  assert.equal((await app.call('GET', `/files/${copy}`, owner.token)).status, 200);
  assert.equal((await app.call('GET', `/files/${copy}`, member.token)).status, 404);
  assert.equal((await app.call('GET', `/files/${copy}`, admin.token)).status, 404);
  // Even someone the notebook is shared with doesn't get it: only the creator.
  await app.call('PUT', `/notebooks/${priv.nb}/shares`, owner.token, { userIds: [member.user.id] });
  assert.equal((await app.call('GET', `/pages/${priv.page}`, member.token)).status, 200);
  assert.ok(!(await list(member)).some((x) => x.id === t.data.id));
  assert.equal((await app.call('POST', `/templates/${t.data.id}/use`, member.token, { pageId: shared.page })).status, 404);
  await app.call('PUT', `/notebooks/${priv.nb}/shares`, owner.token, { userIds: [] });
  // The creator can use it (on a page they can edit) and delete it.
  assert.equal((await app.call('POST', `/templates/${t.data.id}/use`, owner.token, { pageId: shared.page })).status, 200);
  assert.equal((await app.call('DELETE', `/templates/${t.data.id}`, owner.token)).status, 200);
});

test('using a template creates new tasks (original untouched) and copies attachments', async () => {
  const src = (await app.call('POST', `/sections/${shared.sec}/pages`, owner.token, { title: 'Source' })).data.id as string;
  const t1 = await mkTask(owner, src, { priority: 1, description: 'Notes for the spec', dueDate: '2030-01-02', assigneeId: member.user.id });
  const sub = (await app.call('POST', `/workspaces/${ws}/tasks`, owner.token, { title: 'Outline', parentId: t1, priority: 2 })).data.id as string;
  await app.call('PATCH', `/tasks/${sub}`, owner.token, { status: 'done' });
  await app.call('PATCH', `/tasks/${t1}`, owner.token, { status: 'done' }); // a done task: the copy starts open
  const t2 = await mkTask(owner, src, { title: 'Plain task' });
  const img = await upload(owner.token, ws, src, 'PNGDATA', 'pic.png');
  const att = await upload(owner.token, ws, src, 'PDFDATA', 'brief.pdf');
  const content = doc(
    para('Intro'),
    ref(t1),
    { type: 'image', attrs: { src: img.url, alt: 'pic' } },
    { type: 'fileAttachment', attrs: { url: att.url, name: 'brief.pdf', size: 7, mime: 'application/pdf' } },
    { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [para('Checked item')] }] },
    ref(t2),
  );
  const before1 = taskRow(t1);
  const before2 = taskRow(t2);
  const saved = await save(member, src, content, 'Spec kit');
  assert.equal(saved.status, 200);
  assert.equal(saved.data.taskCount, 2);
  assert.equal(saved.data.fileCount, 2);

  // The stored snapshot never contains the original task or file ids.
  const row = db.prepare('SELECT content, tasks FROM templates WHERE id = ?').get(saved.data.id) as { content: string; tasks: string };
  for (const id of [t1, t2, img.id, att.id]) assert.ok(!row.content.includes(id) && !row.tasks.includes(id), `snapshot must not reference ${id}`);
  assert.ok(!row.content.includes('"checked":true'), 'checklist state is reset');

  // Delete the source page and its files: the template still works.
  const target = (await app.call('POST', `/sections/${shared.sec}/pages`, member.token, { title: '' })).data.id as string;
  const used = await app.call('POST', `/templates/${saved.data.id}/use`, member.token, { pageId: target });
  assert.equal(used.status, 200);
  assert.equal(used.data.title, 'Spec kit');
  assert.equal(used.data.taskIds.length, 3, 'two tasks + one subtask');
  const refs = (used.data.content.content as { type: string; attrs?: Record<string, string> }[]).filter((n) => n.type === 'taskRef').map((n) => n.attrs!.taskId);
  assert.equal(refs.length, 2);
  assert.ok(!refs.includes(t1) && !refs.includes(t2), 'new ids');
  const copy1 = taskRow(refs[0])!;
  assert.equal(copy1.title, 'Write spec');
  assert.equal(copy1.description, 'Notes for the spec');
  assert.equal(copy1.priority, 1);
  assert.equal(copy1.status, 'open');
  assert.equal(copy1.completed_at, null);
  assert.equal(copy1.due_date, null);
  assert.equal(copy1.assignee_id, member.user.id, 'assigned to whoever used the template');
  assert.equal(copy1.page_id, target);
  assert.equal(copy1.created_by, member.user.id);
  const subs = db.prepare('SELECT * FROM tasks WHERE parent_id = ?').all(refs[0]) as Record<string, unknown>[];
  assert.deepEqual(subs.map((s) => [s.title, s.priority, s.status]), [['Outline', 2, 'open']]);
  // Originals are untouched.
  assert.deepEqual(taskRow(t1), before1);
  assert.deepEqual(taskRow(t2), before2);
  // Completing the copy does not complete the original.
  assert.equal((await app.call('PATCH', `/tasks/${refs[1]}`, member.token, { status: 'done' })).status, 200);
  assert.equal(taskRow(t2)!.status, 'open');
  // Using it again makes yet more new tasks.
  const again = await app.call('POST', `/templates/${saved.data.id}/use`, member.token, { pageId: target });
  assert.equal(new Set([...used.data.taskIds, ...again.data.taskIds]).size, 6);

  // Attachments: new ids, bytes copied, attached to the target page, and the template's own copies are separate.
  const urls: string[] = [];
  for (const n of used.data.content.content as { type: string; attrs?: Record<string, string> }[]) {
    if (n.type === 'image') urls.push(n.attrs!.src);
    if (n.type === 'fileAttachment') urls.push(n.attrs!.url);
  }
  assert.equal(urls.length, 2);
  for (const u of urls) {
    assert.ok(onDisk(u));
    assert.ok(![img.url, att.url].includes(u));
    const id = u.split('/')[2].split('.')[0];
    const f = db.prepare('SELECT page_id, template_id, workspace_id FROM files WHERE id = ?').get(id) as { page_id: string; template_id: string | null; workspace_id: string };
    assert.deepEqual(f, { page_id: target, template_id: null, workspace_id: ws });
  }
  assert.equal(fs.readFileSync(path.join(filesDir, urls[0].replace('/uploads/', ''))).toString(), 'PNGDATA');

  // Deleting the source page, its tasks and files doesn't break the template or pages made from it.
  await app.call('DELETE', `/pages/${src}`, owner.token);
  fs.unlinkSync(path.join(filesDir, img.url.replace('/uploads/', '')));
  await app.call('DELETE', `/tasks/${t1}`, owner.token);
  const later = await app.call('POST', `/templates/${saved.data.id}/use`, member.token, { pageId: target });
  assert.equal(later.status, 200);
  const nodes = later.data.content.content as { type: string; attrs?: Record<string, string> }[];
  assert.equal(nodes.filter((n) => n.type === 'taskRef').length, 2);
  assert.ok(onDisk(nodes.find((n) => n.type === 'image')!.attrs!.src));

  // Deleting the template removes its own file copies, not the copies already used on pages.
  const templateFiles = (db.prepare('SELECT id, ext FROM files WHERE template_id = ?').all(saved.data.id) as { id: string; ext: string }[]).map((f) => path.join(filesDir, f.id + f.ext));
  assert.equal(templateFiles.length, 2);
  assert.ok(templateFiles.every((p) => fs.existsSync(p)));
  assert.equal((await app.call('DELETE', `/templates/${saved.data.id}`, member.token)).status, 200);
  assert.ok(templateFiles.every((p) => !fs.existsSync(p)), 'template attachments removed from disk');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM files WHERE template_id = ?').get(saved.data.id) as { n: number }).n, 0);
  assert.ok(urls.every(onDisk), 'copies made for pages survive');
});

test('workspace scoping: foreign tasks and files are not captured; templates only work in their own workspace', async () => {
  const other = await app.signUp('TOther');
  const otherPage = (await app.call('GET', `/workspaces/${other.wsId}/tree`, other.token)).data.sections[0].id as string;
  const op = (await app.call('POST', `/sections/${otherPage}/pages`, other.token, { title: 'Other' })).data.id as string;
  const foreignTask = (await app.call('POST', `/workspaces/${other.wsId}/tasks`, other.token, { title: 'Foreign', pageId: op })).data.id as string;
  const foreignFile = await upload(other.token, other.wsId, op);
  // The stranger's resources, referenced from a page in our workspace (as a hand-crafted request could).
  const saved = await save(member, shared.page, doc(para('keep'), ref(foreignTask), { type: 'image', attrs: { src: foreignFile.url } }, ref('00000000-0000-4000-8000-000000000000')));
  assert.equal(saved.status, 200);
  assert.equal(saved.data.taskCount, 0);
  assert.equal(saved.data.fileCount, 0);
  const row = db.prepare('SELECT content FROM templates WHERE id = ?').get(saved.data.id) as { content: string };
  assert.ok(!row.content.includes('taskRef') && !row.content.includes('image') && row.content.includes('keep'));
  // A private-notebook task or file you can't see isn't captured either.
  const secretTask = await mkTask(owner, priv.page, { title: 'Hidden' });
  const secretFile = await upload(owner.token, ws, priv.page);
  const s2 = await save(member, shared.page, doc(ref(secretTask), { type: 'fileAttachment', attrs: { url: secretFile.url } }));
  assert.equal(s2.status, 200);
  assert.equal(s2.data.taskCount + s2.data.fileCount, 0);
  // Using it on a page in another workspace is refused.
  assert.equal((await app.call('POST', `/templates/${saved.data.id}/use`, member.token, { pageId: op })).status, 404);
  const multi = await app.signUp('TMulti');
  await app.call('POST', `/workspaces/${other.wsId}/members`, other.token, { email: multi.user.email, role: 'member' });
  await app.call('POST', `/workspaces/${ws}/members`, owner.token, { email: multi.user.email, role: 'member' });
  assert.equal((await app.call('POST', `/templates/${saved.data.id}/use`, multi.token, { pageId: op })).status, 400);
  assert.ok(!(await list(other, other.wsId)).some((t) => t.id === saved.data.id));
});

test('a template that keeps a task or file from a private notebook is saved private, not to the workspace', async () => {
  // The owner's private-notebook task is assigned to the member, so the member can see it (and so could snapshot it).
  const secret = await mkTask(owner, priv.page, { title: 'Salary review', description: 'confidential' });
  assert.equal((await app.call('PATCH', `/tasks/${secret}`, owner.token, { assigneeId: member.user.id })).status, 200);
  const visible = await mkTask(owner, shared.page, { title: 'Public task' });

  const r = await save(member, shared.page, doc(ref(visible), ref(secret)), 'Has private task');
  assert.equal(r.status, 200);
  assert.equal(r.data.taskCount, 2);
  assert.equal(r.data.visibility, 'private');
  for (const u of [owner, admin, viewer]) assert.ok(!(await list(u)).some((t) => t.id === r.data.id), 'other members never see it');
  assert.equal((await app.call('POST', `/templates/${r.data.id}/use`, owner.token, { pageId: shared.page })).status, 404);
  assert.ok((await list(member)).some((t) => t.id === r.data.id), 'its creator still does');

  // A file on a private-notebook page that the saver has access to behaves the same way.
  const file = await upload(owner.token, ws, priv.page);
  await app.call('PUT', `/notebooks/${priv.nb}/shares`, owner.token, { userIds: [member.user.id] });
  const f = await save(member, shared.page, doc({ type: 'fileAttachment', attrs: { url: file.url } }), 'Has private file');
  assert.equal(f.status, 200);
  assert.equal(f.data.fileCount, 1);
  assert.equal(f.data.visibility, 'private');
  assert.ok(!(await list(admin)).some((t) => t.id === f.data.id));

  // Only shared-notebook tasks: stays workspace-visible.
  const ok = await save(member, shared.page, doc(ref(visible)), 'Public only');
  assert.equal(ok.data.visibility, 'workspace');
  assert.ok((await list(admin)).some((t) => t.id === ok.data.id));
  await app.call('PUT', `/notebooks/${priv.nb}/shares`, owner.token, { userIds: [] });
});

test('limits: name, content shape and size, attachment and template counts', async () => {
  const p = shared.page;
  assert.equal((await save(member, p, doc(), 'n'.repeat(101))).status, 400);
  assert.equal((await app.call('POST', `/pages/${p}/templates`, member.token, { content: doc() })).status, 400);
  assert.equal((await save(member, p, 'nope')).status, 400);
  assert.equal((await save(member, p, { type: 'paragraph' })).status, 400);
  assert.equal((await app.call('POST', `/pages/${p}/templates`, member.token, { name: 'x', content: doc(), icon: 'x'.repeat(40) })).status, 400);
  assert.equal((await save(member, p, doc(para('x'.repeat(310_000))))).status, 413);
  let deep: unknown = para('deep');
  for (let i = 0; i < 60; i++) deep = { type: 'blockquote', content: [deep] };
  assert.equal((await save(member, p, doc(deep))).status, 400);
  // Attachments: more than 20 is refused (and nothing is left behind).
  const files = await Promise.all(Array.from({ length: 21 }, (_, i) => upload(member.token, ws, p, `f${i}`, `f${i}.txt`)));
  const before = (db.prepare('SELECT COUNT(*) AS n FROM files WHERE template_id IS NOT NULL').get() as { n: number }).n;
  const diskBefore = fs.readdirSync(filesDir).length;
  const big = await save(member, p, doc(...files.map((f) => ({ type: 'fileAttachment', attrs: { url: f.url } }))));
  assert.equal(big.status, 413);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM files WHERE template_id IS NOT NULL').get() as { n: number }).n, before);
  assert.equal(fs.readdirSync(filesDir).length, diskBefore, 'no orphaned copies');
  // Too many tasks.
  const refs = [];
  for (let i = 0; i < 101; i++) refs.push(ref(await mkTask(member, p, { title: `t${i}` })));
  assert.equal((await save(member, p, doc(...refs))).status, 413);
  // Per-workspace cap.
  const w = await app.signUp('TCap');
  const wp = (await app.call('POST', `/sections/${(await app.call('GET', `/workspaces/${w.wsId}/tree`, w.token)).data.sections[0].id}/pages`, w.token, { title: 'x' })).data.id;
  const { MAX_TEMPLATES_PER_WORKSPACE } = await import('../server/templates.ts');
  for (let i = 0; i < MAX_TEMPLATES_PER_WORKSPACE; i++) assert.equal((await save(w, wp, doc(para('x')), `t${i}`)).status, 200);
  const over = await save(w, wp, doc(para('x')), 'one too many');
  assert.equal(over.status, 409);
  assert.match(over.data.error, /up to 100/);
});

test('deleting a workspace removes its templates and their attachment copies', async () => {
  const w = await app.signUp('TWsDel');
  const sec = (await app.call('GET', `/workspaces/${w.wsId}/tree`, w.token)).data.sections[0].id;
  const pg = (await app.call('POST', `/sections/${sec}/pages`, w.token, { title: 'x' })).data.id;
  const f = await upload(w.token, w.wsId, pg, 'doomed');
  const t = await save(w, pg, doc({ type: 'fileAttachment', attrs: { url: f.url } }));
  const copy = db.prepare('SELECT id, ext FROM files WHERE template_id = ?').get(t.data.id) as { id: string; ext: string };
  assert.ok(fs.existsSync(path.join(filesDir, copy.id + copy.ext)));
  assert.equal((await app.call('DELETE', `/workspaces/${w.wsId}`, w.token)).status, 200);
  assert.ok(!fs.existsSync(path.join(filesDir, copy.id + copy.ext)));
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM templates WHERE id = ?').get(t.data.id) as { n: number }).n, 0);
});

test('live "templates" events: workspace-visible ones reach members, private ones only their creator', async () => {
  const connect = (token: string) =>
    new Promise<{ ws: WS; msgs: { type: string; workspaceId?: string }[] }>((resolve, reject) => {
      const sock = new WS(`${app.wsOrigin}/api/events`, ['noteapp.v1', `bearer.${token}`]);
      const msgs: { type: string; workspaceId?: string }[] = [];
      sock.on('message', (d) => msgs.push(JSON.parse(String(d))));
      sock.on('open', () => resolve({ ws: sock, msgs }));
      sock.on('error', reject);
    });
  const [m, o] = await Promise.all([connect(member.token), connect(owner.token)]);
  const pub = await save(owner, shared.page, doc(para('p')), 'Evt');
  await save(owner, priv.page, doc(para('p')), 'EvtPriv');
  await new Promise((r) => setTimeout(r, 300));
  const count = (x: { msgs: { type: string }[] }) => x.msgs.filter((e) => e.type === 'templates').length;
  assert.equal(count(m), 1, 'member sees only the workspace-visible one');
  assert.equal(count(o), 2, 'creator sees both');
  await app.call('DELETE', `/templates/${pub.data.id}`, owner.token);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(count(m), 2);
  m.ws.terminate();
  o.ws.terminate();
});
