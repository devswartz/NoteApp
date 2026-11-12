// "Export my data" (GET /api/me/export, server/userExport.ts): any signed-in user, only what they
// can see, rate limited.
import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, type TestApp, type TestUser } from './helpers/app.ts';

let app: TestApp;
let readZip: typeof import('../server/zip.ts').readZip;
let LIMITS: typeof import('../server/ratelimit.ts').LIMITS;
let resetRateLimits: () => void;
let owner: TestUser, member: TestUser, outsider: TestUser, stranger: TestUser;
before(async () => {
  app = await startTestApp();
  ({ readZip } = await import('../server/zip.ts'));
  ({ LIMITS, resetRateLimits } = await import('../server/ratelimit.ts'));
  [owner, member, outsider, stranger] = await Promise.all(['UeOwner', 'UeMember', 'UeOutsider', 'UeStranger'].map((n) => app.signUp(n)));
});
after(() => app.close());
beforeEach(() => resetRateLimits());

async function exportOf(who: TestUser) {
  const r = await fetch(`${app.origin}/api/me/export`, { headers: { authorization: `Bearer ${who.token}` } });
  if (r.status !== 200) return { status: r.status, retryAfter: r.headers.get('retry-after'), files: new Map<string, string>() };
  assert.equal(r.headers.get('content-type'), 'application/zip');
  assert.match(r.headers.get('content-disposition') ?? '', /^attachment; filename=".*\.zip"/);
  const entries = await readZip(Buffer.from(await r.arrayBuffer()));
  return { status: 200, retryAfter: null, files: new Map(entries.map((e) => [e.name, e.data.toString('utf8')])) };
}

async function upload(who: TestUser, ws: string, page: string, name: string, body: string) {
  const r = await fetch(`${app.origin}/api/workspaces/${ws}/files?pageId=${page}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${who.token}`, 'content-type': 'application/octet-stream', 'x-filename': name },
    body,
  });
  assert.equal(r.status, 200);
  return (await r.json()) as { id: string; url: string };
}

/**
 * A team workspace (owner + member): a shared notebook with a page each of them can open, the
 * owner's private notebook, and a page there shared with an outsider. Plus the stranger's own
 * workspace, which nobody else may see.
 */
async function world() {
  const o = owner.token;
  const ws = (await app.call('POST', '/workspaces', o, { name: 'Team space' })).data.id as string;
  await app.call('POST', `/workspaces/${ws}/members`, o, { email: member.user.email, role: 'member' });
  const shared = (await app.call('POST', `/workspaces/${ws}/notebooks`, o, { name: 'Team notebook' })).data;
  const teamPage = (await app.call('POST', `/sections/${shared.sectionId}/pages`, o, { title: 'Team plan' })).data.id as string;
  const memberPage = (await app.call('POST', `/sections/${shared.sectionId}/pages`, member.token, { title: 'Member notes' })).data.id as string;
  const priv = (await app.call('POST', `/workspaces/${ws}/notebooks`, o, { name: 'Owner diary', visibility: 'private' })).data;
  const secretPage = (await app.call('POST', `/sections/${priv.sectionId}/pages`, o, { title: 'Owner secret' })).data.id as string;
  const sharedOut = (await app.call('POST', `/sections/${priv.sectionId}/pages`, o, { title: 'For the outsider' })).data.id as string;
  assert.equal((await app.call('POST', `/pages/${sharedOut}/shares`, o, { email: outsider.user.email, canEdit: false })).data.status, 'shared');

  const strangerPage = (await app.call('POST', `/workspaces/${stranger.wsId}/notebooks`, stranger.token, { name: 'Stranger nb' })).data;
  await app.call('POST', `/sections/${strangerPage.sectionId}/pages`, stranger.token, { title: 'Stranger page' });
  await app.call('POST', `/workspaces/${stranger.wsId}/tasks`, stranger.token, { title: 'Stranger task' });

  // Tasks: the member created one, was assigned one, and can see one that is neither.
  const mine = (await app.call('POST', `/workspaces/${ws}/tasks`, member.token, { title: 'Member created task' })).data.id as string;
  const assigned = (await app.call('POST', `/workspaces/${ws}/tasks`, o, { title: 'Assigned to member', assigneeId: member.user.id })).data.id as string;
  await app.call('POST', `/workspaces/${ws}/tasks`, o, { title: 'Owner own task' });
  await app.call('POST', `/workspaces/${ws}/tasks`, o, { title: 'Owner private task', pageId: secretPage });

  // Comments: the member's and the owner's on the team page; the owner's on the private page.
  await app.call('POST', `/pages/${teamPage}/comments`, member.token, { body: 'Member comment here', quote: 'q' });
  await app.call('POST', `/pages/${teamPage}/comments`, o, { body: 'Owner comment here', quote: 'q' });
  await app.call('POST', `/pages/${secretPage}/comments`, o, { body: 'Owner secret comment', quote: 'q' });

  // Files: one each by the member and the owner on the team page, one in the private notebook.
  const memberFile = await upload(member, ws, memberPage, 'member.txt', 'member file');
  const ownerFile = await upload(owner, ws, teamPage, 'owner.txt', 'owner file');
  const secretFile = await upload(owner, ws, secretPage, 'secret.txt', 'secret file');

  await app.call('PATCH', '/notifications/settings', member.token, { timeZone: 'Europe/Berlin', digestEnabled: true });
  return { ws, teamPage, memberPage, secretPage, sharedOut, mine, assigned, memberFile, ownerFile, secretFile };
}

let w: Awaited<ReturnType<typeof world>>;
test('setup', async () => {
  w = await world();
});

test('needs a session', async () => {
  assert.equal((await fetch(`${app.origin}/api/me/export`)).status, 401);
});

test('a plain member (not an admin) can export, and gets exactly what they can see', async () => {
  const { status, files } = await exportOf(member);
  assert.equal(status, 200);
  const names = [...files.keys()];
  for (const f of ['README.txt', 'profile.json', 'notification-settings.json', 'tasks.json', 'comments.json']) assert.ok(files.has(f), f);

  // Pages: the team notebook's pages (theirs and the owner's) as Markdown; nothing private, nothing from other workspaces.
  assert.ok(files.has('pages/Team space/Team notebook/General/Team plan.md') || names.some((n) => n.endsWith('/Team plan.md')), names.join('\n'));
  assert.ok(names.some((n) => n.endsWith('/Member notes.md')));
  for (const hidden of ['Owner secret', 'For the outsider', 'Stranger page', 'Owner diary', 'Stranger nb'])
    assert.ok(!names.some((n) => n.includes(hidden)), `no ${hidden}`);

  const profile = JSON.parse(files.get('profile.json')!);
  assert.equal(profile.account.email, member.user.email);
  assert.deepEqual(profile.workspaces.map((x: { name: string; role: string }) => [x.name, x.role]).sort(), [
    [(await app.call('GET', '/workspaces', member.token)).data.find((x: { id: string }) => x.id === member.wsId).name, 'owner'],
    ['Team space', 'member'],
  ].sort());

  // Tasks they created or were assigned; not others' tasks, private ones, or other workspaces'.
  const allTasks = JSON.parse(files.get('tasks.json')!) as { id: string; title: string; workspace_id: string; created_by_me: boolean; assigned_to_me: boolean }[];
  assert.ok(allTasks.every((t) => t.workspace_id === w.ws || t.workspace_id === member.wsId), 'only their own workspaces');
  const tasks = allTasks.filter((t) => t.workspace_id === w.ws);
  assert.deepEqual(tasks.map((t) => t.title).sort(), ['Assigned to member', 'Member created task']);
  assert.ok(tasks.find((t) => t.id === w.mine)!.created_by_me);
  assert.ok(tasks.find((t) => t.id === w.assigned)!.assigned_to_me);

  // Their own comments only.
  const comments = JSON.parse(files.get('comments.json')!) as { body: string }[];
  assert.deepEqual(comments.map((c) => c.body), ['Member comment here']);

  // Their uploads only; the owner's file is not "their" upload and the secret one is out of reach.
  assert.equal(files.get(`files/${w.memberFile.url.slice('/uploads/'.length)}`), 'member file');
  assert.ok(!names.some((n) => n.includes(w.ownerFile.id) || n.includes(w.secretFile.id)));

  const settings = JSON.parse(files.get('notification-settings.json')!);
  assert.equal(settings.settings.time_zone, 'Europe/Berlin');
  assert.equal(settings.settings.digest_enabled, true);
  assert.ok(!JSON.stringify(settings).includes('endpoint') && !JSON.stringify(settings).includes('token'), 'no push secrets');
  // Nothing anywhere in the archive about the stranger's workspace or the owner's private notebook.
  const all = [...files.values()].join('\n');
  for (const s of ['Stranger', 'Owner secret', 'Owner private task', 'secret file', stranger.user.email]) assert.ok(!all.includes(s), s);
});

test('a page-share grantee gets the shared page under "Shared with me", and nothing around it', async () => {
  const { status, files } = await exportOf(outsider);
  assert.equal(status, 200);
  const names = [...files.keys()];
  assert.ok(files.has('pages/Shared with me/For the outsider.md'), names.join('\n'));
  const all = [...files.values()].join('\n');
  for (const s of ['Team space', 'Owner diary', 'Owner secret', 'Team plan', 'Owner comment here', 'Owner secret comment']) assert.ok(!all.includes(s), s);
});

test('the owner sees their private notebook in their own export', async () => {
  const { files } = await exportOf(owner);
  const names = [...files.keys()];
  assert.ok(names.some((n) => n.endsWith('/Owner diary/General/Owner secret.md') || (n.includes('/Owner diary/') && n.endsWith('/Owner secret.md'))), names.join('\n'));
  assert.equal(files.get(`files/${w.secretFile.url.slice('/uploads/'.length)}`), 'secret file');
  const comments = JSON.parse(files.get('comments.json')!) as { body: string }[];
  assert.deepEqual(comments.map((c) => c.body).sort(), ['Owner comment here', 'Owner secret comment']);
});

test('after leaving a workspace, its content is no longer in the export', async () => {
  const quitter = await app.signUp('UeQuitter');
  await app.call('POST', `/workspaces/${w.ws}/members`, owner.token, { email: quitter.user.email, role: 'member' });
  assert.ok([...(await exportOf(quitter)).files.keys()].some((n) => n.endsWith('/Team plan.md')));
  assert.equal((await app.call('DELETE', `/workspaces/${w.ws}/members/${quitter.user.id}`, owner.token)).status, 200);
  assert.ok(![...(await exportOf(quitter)).files.keys()].some((n) => n.endsWith('/Team plan.md')));
});

test('rate limited per user, with Retry-After', async () => {
  const u = await app.signUp('UeLimited');
  const codes: number[] = [];
  for (let i = 0; i <= LIMITS.dataExportUser.capacity; i++) codes.push((await exportOf(u)).status);
  assert.deepEqual(codes, [...Array(LIMITS.dataExportUser.capacity).fill(200), 429]);
  const r = await exportOf(u);
  assert.equal(r.status, 429);
  assert.ok(Number(r.retryAfter) > 0);
  assert.equal((await exportOf(member)).status, 200, 'other people are unaffected');
});
