// Section default templates (migration 018): who may set one, inheritance by subsections, clearing
// when the template is deleted, and that a new page's pending template is applied exactly once.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, type TestApp, type TestUser } from './helpers/app.ts';
import { effectiveDefaultTemplate } from '../shared/sections.ts';

let app: TestApp;
let owner: TestUser, member: TestUser, viewer: TestUser, outsider: TestUser;
let db: typeof import('../server/db.ts').db;
let ws: string;
let nb: string, sec: string, sub: string, subsub: string, other: string, page: string;

const doc = (...content: unknown[]) => ({ type: 'doc', content });
const para = (t: string) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });

before(async () => {
  app = await startTestApp();
  [owner, member, viewer, outsider] = await Promise.all(['DOwner', 'DMember', 'DViewer', 'DOutsider'].map((n) => app.signUp(n)));
  ({ db } = await import('../server/db.ts'));
  ws = owner.wsId;
  await app.call('POST', `/workspaces/${ws}/members`, owner.token, { email: member.user.email, role: 'member' });
  await app.call('POST', `/workspaces/${ws}/members`, owner.token, { email: viewer.user.email, role: 'viewer' });
  nb = (await app.call('POST', `/workspaces/${ws}/notebooks`, owner.token, { name: 'Work' })).data.id;
  sec = (await app.call('POST', `/notebooks/${nb}/sections`, owner.token, { name: 'Meetings' })).data.id;
  sub = (await app.call('POST', `/notebooks/${nb}/sections`, owner.token, { name: 'Weekly', parentId: sec })).data.id;
  subsub = (await app.call('POST', `/notebooks/${nb}/sections`, owner.token, { name: 'Team A', parentId: sub })).data.id;
  other = (await app.call('POST', `/notebooks/${nb}/sections`, owner.token, { name: 'Other' })).data.id;
  page = (await app.call('POST', `/sections/${sec}/pages`, owner.token, { title: 'Source' })).data.id;
});
after(() => app.close());

const saveTemplate = async (name: string, sections?: { sectionId: string }[]) =>
  (await app.call('POST', `/pages/${page}/templates`, owner.token, { name, content: doc(para(`Body of ${name}`)), ...(sections ? { sections } : {}) })).data.id as string;
const setDefault = (user: TestUser, sectionId: string, templateId: string | 'none' | null) =>
  app.call('PUT', `/sections/${sectionId}/default-template`, user.token, { templateId });
const treeSections = async (user = owner) =>
  (await app.call('GET', `/workspaces/${ws}/tree`, user.token)).data.sections as { id: string; parentId: string | null; defaultTemplateId: string | null; noDefaultTemplate: boolean }[];
const newPage = async (user: TestUser, sectionId: string, template?: string) =>
  (await app.call('POST', `/sections/${sectionId}/pages`, user.token, { title: '', ...(template ? { template } : {}) })).data as { id: string; pendingTemplate: { id: string; name: string } | null };
const claim = (user: TestUser, pageId: string, body: unknown = {}) => app.call('POST', `/pages/${pageId}/pending-template`, user.token, body);

test('only editors set a section default; viewers, outsiders and page-share grantees cannot', async () => {
  const t = await saveTemplate('Standup');
  assert.equal((await setDefault(viewer, sec, t)).status, 403);
  assert.equal((await setDefault(outsider, sec, t)).status, 404);
  // An edit share on one page in the section reaches that page only, never the section.
  await app.call('POST', `/pages/${page}/shares`, owner.token, { email: outsider.user.email, canEdit: true });
  assert.equal((await setDefault(outsider, sec, t)).status, 404);
  assert.equal((await setDefault(member, sec, t)).status, 200);
  const s = (await treeSections(viewer)).find((x) => x.id === sec)!;
  assert.equal(s.defaultTemplateId, t, 'everyone sees the default in the tree');
  // A page-share grantee can't claim a page's pending template either.
  const p = await newPage(owner, sec, 'default');
  assert.equal((await claim(outsider, p.id)).status, 404);
  assert.equal((await setDefault(owner, sec, null)).status, 200);
});

test('only templates shared with the workspace and offered in the section can be a default', async () => {
  const elsewhere = await saveTemplate('Elsewhere only', [{ sectionId: other }]);
  assert.equal((await setDefault(owner, sec, elsewhere)).status, 400);
  assert.equal((await setDefault(owner, other, elsewhere)).status, 200);
  assert.equal((await setDefault(owner, sec, 'no-such-template')).status, 400);
  // A private template (saved from a private notebook) is only its creator's: not a default for everyone.
  const privNb = (await app.call('POST', `/workspaces/${ws}/notebooks`, owner.token, { name: 'Mine', visibility: 'private' })).data.id;
  const privSec = (await app.call('POST', `/notebooks/${privNb}/sections`, owner.token, { name: 'S' })).data.id;
  const privPage = (await app.call('POST', `/sections/${privSec}/pages`, owner.token, { title: 'P' })).data.id;
  const priv = (await app.call('POST', `/pages/${privPage}/templates`, owner.token, { name: 'Private', content: doc(para('x')) })).data;
  assert.equal(priv.visibility, 'private');
  assert.equal((await setDefault(owner, privSec, priv.id)).status, 400);
});

test('subsections inherit the nearest ancestor default unless they set their own or None', async () => {
  const top = await saveTemplate('Top default');
  const mid = await saveTemplate('Weekly default');
  assert.equal((await setDefault(owner, sec, top)).status, 200);

  // Inherited two levels down.
  let p = await newPage(member, subsub, 'default');
  assert.deepEqual(p.pendingTemplate, { id: top, name: 'Top default' });
  // The subsection's own default wins for it and below.
  assert.equal((await setDefault(owner, sub, mid)).status, 200);
  p = await newPage(member, subsub, 'default');
  assert.equal(p.pendingTemplate?.id, mid);
  assert.equal((await newPage(member, sec, 'default')).pendingTemplate?.id, top);
  // None on the subsection stops the inheritance.
  assert.equal((await setDefault(owner, sub, 'none')).status, 200);
  assert.equal((await newPage(member, sub, 'default')).pendingTemplate, null);
  assert.equal((await newPage(member, subsub, 'default')).pendingTemplate, null);
  // Back to inheriting.
  assert.equal((await setDefault(owner, sub, null)).status, 200);
  assert.equal((await newPage(member, subsub, 'default')).pendingTemplate?.id, top);
  // The shared helper agrees with the server.
  assert.equal(effectiveDefaultTemplate(await treeSections(), subsub)?.templateId, top);
  assert.equal(effectiveDefaultTemplate(await treeSections(), subsub)?.from, sec);
  await setDefault(owner, sec, null);
});

test('pages are only filled when the app asks: imports, quick add and the API make blank pages', async () => {
  const t = await saveTemplate('Always');
  await setDefault(owner, sec, t);
  const plain = await newPage(owner, sec); // no `template`: the API, imports, quick add, share extension
  assert.equal(plain.pendingTemplate, null);
  assert.equal((await app.call('GET', `/pages/${plain.id}`, owner.token)).data.pendingTemplate, false);
  // A copied page doesn't carry it either.
  const made = await newPage(owner, sec, 'default');
  const copy = await app.call('POST', `/pages/${made.id}/copy`, owner.token, {});
  if (copy.status === 200 && copy.data?.id) {
    const row = db.prepare('SELECT pending_template_id AS t FROM pages WHERE id = ?').get(copy.data.id) as { t: string | null };
    assert.equal(row.t, null);
  }
  await setDefault(owner, sec, null);
});

test('deleting the template clears the default (and a pending fill)', async () => {
  const t = await saveTemplate('Short lived');
  await setDefault(owner, sec, t);
  const p = await newPage(owner, sec, 'default');
  assert.equal(p.pendingTemplate?.id, t);
  assert.equal((await app.call('DELETE', `/templates/${t}`, owner.token)).status, 200);
  const s = (await treeSections()).find((x) => x.id === sec)!;
  assert.equal(s.defaultTemplateId, null);
  assert.equal((await claim(owner, p.id)).data, null, 'nothing left to apply');
  assert.equal((await newPage(owner, sec, 'default')).pendingTemplate, null);
});

test('a pending template is applied once: the first claim gets it, every other claim gets nothing', async () => {
  // A template with a task, so a double apply would show as duplicate tasks.
  const task = (await app.call('POST', `/workspaces/${ws}/tasks`, owner.token, { title: 'Agenda item', pageId: page })).data.id;
  const t = (await app.call('POST', `/pages/${page}/templates`, owner.token, {
    name: 'Notes {date}',
    content: doc(para('Hello'), { type: 'taskRef', attrs: { taskId: task } }),
  })).data.id as string;
  await setDefault(owner, sec, t);
  const p = await newPage(owner, sec, 'default');
  assert.equal((await app.call('GET', `/pages/${p.id}`, owner.token)).data.pendingTemplate, true);
  assert.equal((await app.call('GET', `/pages/${p.id}`, member.token)).data.pendingTemplate, false, 'only the creator fills it');
  // Another editor can't claim someone else's new page.
  assert.equal((await claim(member, p.id)).status, 403);

  // Two clients of the creator race: exactly one gets the content.
  const [a, b] = await Promise.all([claim(owner, p.id), claim(owner, p.id)]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const got = [a.data, b.data].filter(Boolean);
  assert.equal(got.length, 1);
  assert.equal(got[0].templateId, t);
  assert.equal(got[0].name, 'Notes {date}', 'placeholders are filled by the client, in the user’s locale');
  assert.equal(got[0].taskIds.length, 1);
  const tasksOnPage = db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE page_id = ?').get(p.id) as { n: number };
  assert.equal(tasksOnPage.n, 1, 'the template’s task is created once');
  assert.equal((await claim(owner, p.id)).data, null);
  assert.equal((await app.call('GET', `/pages/${p.id}`, owner.token)).data.pendingTemplate, false);

  // discard: clears it without creating anything.
  const q = await newPage(owner, sec, 'default');
  assert.equal((await claim(owner, q.id, { discard: true })).data, null);
  assert.equal((await claim(owner, q.id)).data, null);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE page_id = ?').get(q.id) as { n: number }).n, 0);
  await setDefault(owner, sec, null);
});

test('New page from template: any template offered in the section', async () => {
  const offered = await saveTemplate('Retro');
  const elsewhere = await saveTemplate('Other only', [{ sectionId: other }]);
  assert.equal((await newPage(member, sec, offered)).pendingTemplate?.id, offered);
  assert.equal((await app.call('POST', `/sections/${sec}/pages`, member.token, { title: '', template: elsewhere })).status, 400);
  // Viewers can't make pages at all.
  assert.equal((await app.call('POST', `/sections/${sec}/pages`, viewer.token, { title: '', template: offered })).status, 403);
});
