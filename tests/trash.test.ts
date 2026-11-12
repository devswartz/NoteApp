// Trash (server/trash.ts, migration 019): deleting moves a page, section or notebook to Trash for 60 days; restoring,
// deleting forever, expiry (with an injected clock), who may see and act on it, and what stays invisible meanwhile.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, type TestApp, type TestUser } from './helpers/app.ts';
import type { Tree, TrashItem } from '../shared/types.ts';

let app: TestApp;
before(async () => {
  process.env.ADMIN_EMAILS = 'site-admin@example.com';
  app = await startTestApp();
});
after(() => app.close());

const DAY = 86_400_000;

/** A team workspace with an owner, an admin, a member, a viewer, and a shared notebook "Handbook" (section "General"). */
async function team() {
  const owner = await app.signUp('Trash Owner');
  const ws = (await app.call('POST', '/workspaces', owner.token, { name: 'Trash Team' })).data.id as string;
  const add = async (name: string, role: string): Promise<TestUser> => {
    const u = await app.signUp(name);
    await app.call('POST', `/workspaces/${ws}/members`, owner.token, { email: u.user.email, role });
    return u;
  };
  const admin = await add('Trash Admin', 'admin');
  const member = await add('Trash Member', 'member');
  const viewer = await add('Trash Viewer', 'viewer');
  const nb = (await app.call('POST', `/workspaces/${ws}/notebooks`, owner.token, { name: 'Handbook' })).data as { id: string; sectionId: string };
  return { owner, admin, member, viewer, ws, nb: nb.id, general: nb.sectionId };
}

const newPage = async (u: TestUser, section: string, title: string) => (await app.call('POST', `/sections/${section}/pages`, u.token, { title })).data.id as string;
const newSection = async (u: TestUser, nb: string, name: string, parentId?: string) => (await app.call('POST', `/notebooks/${nb}/sections`, u.token, { name, parentId })).data.id as string;
const tree = async (u: TestUser, ws: string) => (await app.call('GET', `/workspaces/${ws}/tree`, u.token)).data as Tree;
const trash = async (u: TestUser, ws: string) => (await app.call('GET', `/workspaces/${ws}/trash`, u.token)).data as TrashItem[];
const search = async (u: TestUser, ws: string, q: string) => ((await app.call('GET', `/workspaces/${ws}/search?q=${encodeURIComponent(q)}`, u.token)).data.pages as { id: string }[]).map((p) => p.id);
const tasks = async (u: TestUser, ws: string) => (await app.call('GET', `/workspaces/${ws}/tasks`, u.token)).data as { id: string; pageId: string | null }[];
const dbm = async () => (await import('../server/db.ts')).db;

test('deleting a page moves it to Trash: gone from the tree and search, listed in Trash, its tasks stay; restore brings the page back', async () => {
  const t = await team();
  const p = await newPage(t.owner, t.general, 'Zanzibar notes');
  const task = (await app.call('POST', `/workspaces/${t.ws}/tasks`, t.owner.token, { title: 'On the page', pageId: p })).data;
  assert.deepEqual(await search(t.member, t.ws, 'zanzibar'), [p]);

  const del = await app.call('DELETE', `/pages/${p}`, t.member.token);
  assert.equal(del.status, 200);
  assert.equal(del.data.tasks, 1, 'the delete says how many tasks are on it');

  assert.ok(!(await tree(t.owner, t.ws)).pages.some((x) => x.id === p), 'not in the tree');
  assert.deepEqual(await search(t.owner, t.ws, 'zanzibar'), [], 'not in search');
  assert.equal((await tasks(t.owner, t.ws)).find((x) => x.id === task.id)?.pageId, p, 'its task stays in the task list, still on its page');
  const items = await trash(t.owner, t.ws);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'page');
  assert.equal(items[0].name, 'Zanzibar notes');
  assert.equal(items[0].path, 'Handbook › General');
  assert.equal(items[0].deletedByName, 'Trash Member');
  assert.ok(items[0].daysLeft >= 59 && items[0].daysLeft <= 60, `60 days to go: ${items[0].daysLeft}`);

  // It opens read-only for the people who could restore it, and can't be changed.
  const open = await app.call('GET', `/pages/${p}`, t.member.token);
  assert.equal(open.status, 200);
  assert.equal(open.data.trashed, true);
  assert.equal(open.data.canEdit, false);
  assert.equal((await app.call('PATCH', `/pages/${p}`, t.member.token, { title: 'Renamed' })).status, 403);

  const back = await app.call('POST', `/trash/page/${p}/restore`, t.member.token);
  assert.equal(back.status, 200);
  assert.equal(back.data.movedTo, '', 'back where it was');
  assert.ok((await tree(t.owner, t.ws)).pages.some((x) => x.id === p && x.sectionId === t.general));
  assert.deepEqual(await search(t.owner, t.ws, 'zanzibar'), [p]);
  const restoredTask = (await tasks(t.owner, t.ws)).find((x) => x.id === task.id);
  assert.equal(restoredTask?.pageId, p, 'the task is back, still on its page');
  assert.deepEqual(await trash(t.owner, t.ws), []);
  assert.equal((await app.call('GET', `/pages/${p}`, t.member.token)).data.trashed, false);
});

test('a section goes to Trash with its subsections and pages as one entry, and comes back as one', async () => {
  const t = await team();
  const sprint = await newSection(t.owner, t.nb, 'Sprint');
  const week = await newSection(t.owner, t.nb, 'Week 1', sprint);
  const p1 = await newPage(t.owner, sprint, 'Plan');
  const p2 = await newPage(t.owner, week, 'Standup');
  assert.equal((await app.call('DELETE', `/sections/${sprint}`, t.member.token)).status, 200);

  const tr = await tree(t.owner, t.ws);
  for (const id of [sprint, week]) assert.ok(!tr.sections.some((s) => s.id === id));
  for (const id of [p1, p2]) assert.ok(!tr.pages.some((p) => p.id === id));
  const items = await trash(t.owner, t.ws);
  assert.equal(items.length, 1, 'one entry for the whole section');
  assert.deepEqual([items[0].kind, items[0].name, items[0].pages, items[0].sections], ['section', 'Sprint', 2, 1]);

  assert.equal((await app.call('POST', `/trash/section/${sprint}/restore`, t.member.token)).status, 200);
  const back = await tree(t.owner, t.ws);
  assert.equal(back.sections.find((s) => s.id === week)?.parentId, sprint, 'the nesting is as it was');
  assert.ok(back.pages.some((p) => p.id === p1) && back.pages.some((p) => p.id === p2));
});

test('a notebook goes to Trash with everything in it; only its creator or an admin can delete or restore it', async () => {
  const t = await team();
  const mine = (await app.call('POST', `/workspaces/${t.ws}/notebooks`, t.member.token, { name: 'Member notebook' })).data as { id: string; sectionId: string };
  const p = await newPage(t.member, mine.sectionId, 'Inside');
  assert.equal((await app.call('DELETE', `/notebooks/${t.nb}`, t.member.token)).status, 403, 'someone else cannot delete the notebook');
  assert.equal((await app.call('DELETE', `/notebooks/${mine.id}`, t.member.token)).status, 200);
  const nbs = (await tree(t.owner, t.ws)).notebooks;
  assert.ok(!nbs.some((n) => n.id === mine.id));
  assert.ok(!(await tree(t.owner, t.ws)).pages.some((x) => x.id === p));
  // The creator and the admins see it; another member does not (they could not have deleted it).
  assert.equal((await trash(t.member, t.ws)).length, 1);
  assert.equal((await trash(t.admin, t.ws)).length, 1);
  assert.equal((await trash(t.viewer, t.ws)).length, 0);
  const other = await app.signUp('Other Member');
  await app.call('POST', `/workspaces/${t.ws}/members`, t.owner.token, { email: other.user.email, role: 'member' });
  assert.equal((await trash(other, t.ws)).length, 0, 'a member who is not the creator does not see the notebook');
  assert.equal((await app.call('POST', `/trash/notebook/${mine.id}/restore`, other.token)).status, 404);
  assert.equal((await app.call('POST', `/trash/notebook/${mine.id}/restore`, t.admin.token)).status, 200);
  assert.ok((await tree(t.owner, t.ws)).notebooks.some((n) => n.id === mine.id));
  assert.ok((await tree(t.owner, t.ws)).pages.some((x) => x.id === p));
});

test('restoring when the parent is gone: a page goes to the first section, a section to the top of its notebook, and it says so', async () => {
  const t = await team();
  const other = await newSection(t.owner, t.nb, 'Other');
  // A page trashed on its own, then its section trashed: the page has nowhere to go back to.
  const p = await newPage(t.owner, t.general, 'Orphan');
  await app.call('DELETE', `/pages/${p}`, t.owner.token);
  await app.call('DELETE', `/sections/${t.general}`, t.owner.token);
  const r = await app.call('POST', `/trash/page/${p}/restore`, t.owner.token);
  assert.equal(r.status, 200);
  assert.equal(r.data.movedTo, 'Other', 'told which section it went to');
  assert.equal((await tree(t.owner, t.ws)).pages.find((x) => x.id === p)?.sectionId, other);

  // A subsection trashed on its own, then its parent: it comes back at the top level.
  const parent = await newSection(t.owner, t.nb, 'Parent');
  const child = await newSection(t.owner, t.nb, 'Child', parent);
  await app.call('DELETE', `/sections/${child}`, t.owner.token);
  await app.call('DELETE', `/sections/${parent}`, t.owner.token);
  const r2 = await app.call('POST', `/trash/section/${child}/restore`, t.owner.token);
  assert.equal(r2.status, 200);
  assert.equal(r2.data.movedTo, 'Handbook');
  assert.equal((await tree(t.owner, t.ws)).sections.find((s) => s.id === child)?.parentId, null);

  // With its notebook in Trash too, restore the notebook first.
  const p3 = await newPage(t.owner, other, 'Last');
  await app.call('DELETE', `/pages/${p3}`, t.owner.token);
  await app.call('DELETE', `/notebooks/${t.nb}`, t.owner.token);
  assert.equal((await app.call('POST', `/trash/page/${p3}/restore`, t.owner.token)).status, 409);
});

test('delete forever removes the item and its tasks become standalone; items older than 60 days are removed by the daily job (injected clock)', async () => {
  const t = await team();
  const db = await dbm();
  const { purgeExpired } = await import('../server/trash.ts');
  const p = await newPage(t.owner, t.general, 'Short lived');
  const task = (await app.call('POST', `/workspaces/${t.ws}/tasks`, t.owner.token, { title: 'Outlives the page', pageId: p })).data;
  await app.call('DELETE', `/pages/${p}`, t.owner.token);
  const old = await newPage(t.owner, t.general, 'Old news');
  await app.call('DELETE', `/pages/${old}`, t.owner.token);

  // 59 days on: still there. 61 days on: removed, with its task standalone and visible.
  assert.equal(purgeExpired(new Date(Date.now() + 59 * DAY)), 0);
  assert.equal((await trash(t.owner, t.ws)).length, 2);
  assert.ok(purgeExpired(new Date(Date.now() + 61 * DAY)) >= 2, 'the daily job removes what is past 60 days (including other tests trash)');
  assert.equal(db.prepare('SELECT 1 FROM pages WHERE id IN (?, ?)').get(p, old), undefined, 'gone from the database');
  assert.deepEqual(await trash(t.owner, t.ws), []);
  assert.equal((await tasks(t.owner, t.ws)).find((x) => x.id === task.id)?.pageId, null, 'the task is standalone and visible');

  // Delete forever by hand; only for what is in the Trash.
  const q = await newPage(t.owner, t.general, 'Delete me');
  assert.equal((await app.call('DELETE', `/trash/page/${q}`, t.owner.token)).status, 404, 'a live page is not in the Trash');
  await app.call('DELETE', `/pages/${q}`, t.owner.token);
  assert.equal((await app.call('DELETE', `/trash/page/${q}`, t.viewer.token)).status, 404);
  assert.equal((await app.call('DELETE', `/trash/page/${q}`, t.member.token)).status, 200);
  assert.equal((await app.call('GET', `/pages/${q}`, t.owner.token)).status, 404);
});

test('permissions: viewers and page-share holders see nothing; a private notebook\'s Trash is visible only to people who could see it; emptying is for admins', async () => {
  const t = await team();
  const p = await newPage(t.owner, t.general, 'Shared page');
  const outsider = await app.signUp('Trash Outsider');
  assert.equal((await app.call('POST', `/pages/${p}/shares`, t.owner.token, { email: outsider.user.email, canEdit: false })).status, 200);
  assert.equal((await app.call('GET', `/pages/${p}`, outsider.token)).status, 200, 'shared: the outsider can open it');
  await app.call('DELETE', `/pages/${p}`, t.owner.token);
  assert.equal((await app.call('GET', `/pages/${p}`, outsider.token)).status, 404, 'in Trash it is the owner\'s: the page share sees nothing');
  assert.equal((await app.call('GET', `/workspaces/${t.ws}/trash`, outsider.token)).status, 404);
  assert.equal((await app.call('GET', `/pages/${p}`, t.viewer.token)).status, 404, 'a viewer cannot open it');
  assert.deepEqual(await trash(t.viewer, t.ws), []);
  assert.equal((await app.call('POST', `/trash/page/${p}/restore`, t.viewer.token)).status, 404);

  // A private notebook: its Trash is its creator's (and the people it is shared with), not even an admin's.
  const priv = (await app.call('POST', `/workspaces/${t.ws}/notebooks`, t.member.token, { name: 'Mine', visibility: 'private' })).data as { id: string; sectionId: string };
  const pp = await newPage(t.member, priv.sectionId, 'Private thing');
  await app.call('DELETE', `/pages/${pp}`, t.member.token);
  assert.ok((await trash(t.member, t.ws)).some((i) => i.id === pp));
  assert.ok(!(await trash(t.admin, t.ws)).some((i) => i.id === pp), 'an admin cannot see a private notebook\'s Trash');
  assert.equal((await app.call('POST', `/trash/page/${pp}/restore`, t.admin.token)).status, 404);
  assert.equal((await app.call('GET', `/pages/${pp}`, t.admin.token)).status, 404);

  // Emptying: owners and admins, and only what they can see.
  assert.equal((await app.call('DELETE', `/workspaces/${t.ws}/trash`, t.member.token)).status, 403);
  const e = await app.call('DELETE', `/workspaces/${t.ws}/trash`, t.admin.token);
  assert.equal(e.status, 200);
  assert.equal(e.data.removed, 1, 'only the shared notebook\'s page: the private one is not theirs to empty');
  assert.ok((await trash(t.member, t.ws)).some((i) => i.id === pp), 'the private notebook\'s Trash is untouched');
});

test('search and links leave a trashed page out, its tasks stay; the tasks stay visible to the right people', async () => {
  const t = await team();
  const p = await newPage(t.owner, t.general, 'Quokka report');
  const linker = await newPage(t.owner, t.general, 'Linker');
  const task = (await app.call('POST', `/workspaces/${t.ws}/tasks`, t.owner.token, { title: 'Quokka task', pageId: p, dueDate: '2026-12-01' })).data;
  await app.call('DELETE', `/pages/${p}`, t.owner.token);
  assert.ok((await tasks(t.owner, t.ws)).some((x) => x.id === task.id), 'its task is still in the list');
  const found = await app.call('GET', `/workspaces/${t.ws}/search?q=quokka`, t.owner.token);
  assert.equal(found.data.pages.length, 0, 'the page is not found');
  assert.equal(found.data.tasks.length, 1, 'its task still is');
  assert.equal((await app.call('GET', `/pages/${linker}/backlinks`, t.owner.token)).status, 200);
  // Notebook trash hides everything in it from the tree.
  await app.call('DELETE', `/notebooks/${t.nb}`, t.owner.token);
  const after = await tree(t.owner, t.ws);
  assert.ok(!after.notebooks.some((n) => n.id === t.nb) && !after.pages.some((x) => x.id === linker));
});

test('account deletion hard-deletes a user\'s private content at once, trashed or not', async () => {
  const u = await app.signUp('Trash Leaver');
  const nb = (await app.call('POST', `/workspaces/${u.wsId}/notebooks`, u.token, { name: 'Private', visibility: 'private' })).data as { id: string; sectionId: string };
  const p = await newPage(u, nb.sectionId, 'Secret');
  await app.call('DELETE', `/pages/${p}`, u.token); // in the Trash
  const db = await dbm();
  assert.ok(db.prepare('SELECT 1 FROM pages WHERE id = ?').get(p), 'still stored while in the Trash');
  const r = await app.call('DELETE', '/auth/account', u.token, { password: 'password123' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(db.prepare('SELECT 1 FROM pages WHERE id = ?').get(p), undefined, 'gone at once, no 60 days');
});

test('trashed and live rows stay consistent: nothing in a batch is left half-flagged', async () => {
  const t = await team();
  const db = await dbm();
  const s = await newSection(t.owner, t.nb, 'Batch');
  const sub = await newSection(t.owner, t.nb, 'Inner', s);
  const a = await newPage(t.owner, s, 'A');
  const b = await newPage(t.owner, sub, 'B');
  const own = await newPage(t.owner, s, 'Trashed earlier');
  await app.call('DELETE', `/pages/${own}`, t.owner.token);
  await app.call('DELETE', `/sections/${s}`, t.owner.token);
  const batch = (id: string) => db.prepare('SELECT trash_id FROM pages WHERE id = ?').pluck().get(id);
  assert.equal(batch(a), s);
  assert.equal(batch(b), s);
  assert.equal(batch(own), own, 'a page trashed earlier keeps its own entry and its own 60 days');
  assert.equal((await trash(t.owner, t.ws)).length, 2);
  // Restoring the section leaves the earlier page in Trash.
  await app.call('POST', `/trash/section/${s}/restore`, t.owner.token);
  const live = (await tree(t.owner, t.ws)).pages.map((p) => p.id);
  assert.ok(live.includes(a) && live.includes(b) && !live.includes(own));
  assert.deepEqual((await trash(t.owner, t.ws)).map((i) => i.id), [own]);
});

test('tasks on a trashed page or notebook stay visible to workspace members (not only the assignee), and to nobody outside it; the tree lists the trashed page for the task chip', async () => {
  const t = await team();
  const p = await newPage(t.owner, t.general, 'Chip page');
  const task = (await app.call('POST', `/workspaces/${t.ws}/tasks`, t.owner.token, { title: 'Stays listed', pageId: p })).data;
  const outsider = await app.signUp('Trash Chip Outsider');
  await app.call('POST', `/pages/${p}/shares`, t.owner.token, { email: outsider.user.email, canEdit: false });
  const shared = async () => app.call('GET', `/pages/${p}/tasks`, outsider.token);
  assert.ok(((await shared()).data as { id: string }[]).some((x) => x.id === task.id), 'a page-share holder sees the task while the page is live');
  await app.call('DELETE', `/pages/${p}`, t.owner.token);
  assert.ok((await tasks(t.member, t.ws)).some((x) => x.id === task.id), 'a member who is not the assignee still sees it');
  assert.ok([403, 404].includes((await shared()).status), 'the page share ends with the page going to Trash: its tasks are no longer theirs to see');
  assert.deepEqual((await tree(t.member, t.ws)).trashedPages?.filter((x) => x.id === p), [{ id: p, title: 'Chip page' }], 'the tree names the trashed page (for the "in Trash" chip)');
  assert.deepEqual((await tree(t.viewer, t.ws)).trashedPages, [], 'viewers get no trashed pages');
  // A trashed notebook keeps its tasks listed for the other members too.
  const nb = (await app.call('POST', `/workspaces/${t.ws}/notebooks`, t.owner.token, { name: 'Gone notebook' })).data as { id: string; sectionId: string };
  const q = await newPage(t.owner, nb.sectionId, 'In gone notebook');
  const task2 = (await app.call('POST', `/workspaces/${t.ws}/tasks`, t.owner.token, { title: 'Notebook task', pageId: q })).data;
  await app.call('DELETE', `/notebooks/${nb.id}`, t.owner.token);
  assert.ok((await tasks(t.member, t.ws)).some((x) => x.id === task2.id), 'still listed for another member');
  assert.ok((await tasks(t.admin, t.ws)).some((x) => x.id === task2.id));
});
