// Comment threads on page selections: permissions, lifecycle, live events.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import WS from 'ws';
import { startTestApp, type TestApp, type TestUser } from './helpers/app.ts';

const waitFor = (cond: () => boolean, ms: number, what: string) =>
  new Promise<void>((resolve, reject) => {
    const end = Date.now() + ms;
    const tick = () => (cond() ? resolve() : Date.now() > end ? reject(new Error(`timed out: ${what}`)) : setTimeout(tick, 15));
    tick();
  });

let app: TestApp;
const sockets: WS[] = [];
before(async () => {
  app = await startTestApp();
});
after(async () => {
  for (const s of sockets) s.terminate();
  await app.close();
});

async function team() {
  const [owner, member, viewer, outsider] = await Promise.all(['Ola', 'Mo', 'Vi', 'Out'].map((n) => app.signUp(n)));
  await app.call('POST', `/workspaces/${owner.wsId}/members`, owner.token, { email: member.user.email, role: 'member' });
  await app.call('POST', `/workspaces/${owner.wsId}/members`, owner.token, { email: viewer.user.email, role: 'viewer' });
  await app.call('POST', `/workspaces/${owner.wsId}/members`, owner.token, { email: outsider.user.email, role: 'member' });
  const nb = (await app.call('POST', `/workspaces/${owner.wsId}/notebooks`, owner.token, { name: 'N' })).data.id;
  const sec = (await app.call('POST', `/notebooks/${nb}/sections`, owner.token, { name: 'S' })).data.id;
  const pageId = (await app.call('POST', `/sections/${sec}/pages`, owner.token, { title: 'P' })).data.id as string;
  return { owner, member, viewer, outsider, pageId, notebookId: nb as string };
}

const start = (u: TestUser, pageId: string, body = 'Is this right?', threadId: string = crypto.randomUUID()) =>
  app.call('POST', `/pages/${pageId}/comments`, u.token, { threadId, quote: 'the selected text', body });

test('start, reply, edit, resolve, reopen and delete a thread', async () => {
  const { owner, member, viewer, pageId } = await team();
  const threadId = crypto.randomUUID();
  const r = await start(member, pageId, 'Is this right?', threadId);
  assert.equal(r.status, 200);
  assert.equal(r.data.id, threadId);
  assert.equal(r.data.quote, 'the selected text');
  assert.equal(r.data.comments.length, 1);
  // Retrying the create is idempotent.
  assert.equal((await start(member, pageId, 'Is this right?', threadId)).data.comments.length, 1);
  // Someone else can't reuse the id.
  assert.equal((await start(owner, pageId, 'x', threadId)).status, 409);

  const reply = await app.call('POST', `/comment-threads/${threadId}/replies`, owner.token, { body: 'Yes' });
  assert.deepEqual(reply.data.comments.map((c: { body: string }) => c.body), ['Is this right?', 'Yes']);

  // Viewers read but can't write.
  const list = await app.call('GET', `/pages/${pageId}/comments`, viewer.token);
  assert.equal(list.status, 200);
  assert.equal(list.data[0].comments.length, 2);
  assert.equal((await app.call('POST', `/comment-threads/${threadId}/replies`, viewer.token, { body: 'no' })).status, 403);
  assert.equal((await start(viewer, pageId)).status, 403);

  // Only the author edits.
  const ownerComment = reply.data.comments[1].id;
  assert.equal((await app.call('PATCH', `/comments/${ownerComment}`, member.token, { body: 'hijack' })).status, 403);
  const edited = await app.call('PATCH', `/comments/${ownerComment}`, owner.token, { body: 'Yes, confirmed' });
  assert.equal(edited.data.comments[1].body, 'Yes, confirmed');
  assert.ok(edited.data.comments[1].editedAt);

  // Resolve, then a reply reopens it.
  const res = await app.call('PATCH', `/comment-threads/${threadId}`, member.token, { resolved: true });
  assert.equal(res.data.resolvedBy, member.user.id);
  const reopened = await app.call('POST', `/comment-threads/${threadId}/replies`, member.token, { body: 'one more thing' });
  assert.equal(reopened.data.resolvedAt, null);

  // Deleting the thread: creator or admin only.
  assert.equal((await app.call('DELETE', `/comment-threads/${threadId}`, viewer.token)).status, 403);
  assert.equal((await app.call('DELETE', `/comment-threads/${threadId}`, owner.token)).status, 200);
  assert.deepEqual((await app.call('GET', `/pages/${pageId}/comments`, owner.token)).data, []);
});

test('deleting the last comment deletes the thread; validation', async () => {
  const { member, pageId } = await team();
  const t = (await start(member, pageId)).data;
  assert.equal((await app.call('POST', `/pages/${pageId}/comments`, member.token, { threadId: 'nope', body: 'x' })).status, 400);
  assert.equal((await app.call('POST', `/pages/${pageId}/comments`, member.token, { body: '  ' })).status, 400);
  const del = await app.call('DELETE', `/comments/${t.comments[0].id}`, member.token);
  assert.deepEqual(del.data, { ok: true, threadDeleted: true });
});

test('comments on a private notebook page are invisible to others, and so are their events', async () => {
  const { owner, member, outsider, pageId, notebookId } = await team();
  await app.call('PATCH', `/notebooks/${notebookId}`, owner.token, { visibility: 'private' });
  assert.equal((await app.call('GET', `/pages/${pageId}/comments`, member.token)).status, 404);
  const t = (await start(owner, pageId)).data;
  assert.equal((await app.call('POST', `/comment-threads/${t.id}/replies`, outsider.token, { body: 'x' })).status, 404);
  assert.equal((await app.call('PATCH', `/comment-threads/${t.id}`, outsider.token, { resolved: true })).status, 404);
});

test('comment changes are pushed live to people who can see the page', async () => {
  const { owner, member, pageId } = await team();
  const msgs: { type: string; pageId?: string }[] = [];
  const ws = new WS(`${app.wsOrigin}/api/events`, ['noteapp.v1', `bearer.${member.token}`]);
  sockets.push(ws);
  ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
  await new Promise((r) => ws.on('open', r));
  await start(owner, pageId);
  await waitFor(() => msgs.some((m) => m.type === 'comments' && m.pageId === pageId), 2000, 'comments event');
});

test('live comment events for a private page are withheld from members who cannot see it', async () => {
  const { owner, member, pageId, notebookId } = await team();
  await app.call('PATCH', `/notebooks/${notebookId}`, owner.token, { visibility: 'private' });
  const listen = async (token: string) => {
    const msgs: { type: string; pageId?: string }[] = [];
    const ws = new WS(`${app.wsOrigin}/api/events`, ['noteapp.v1', `bearer.${token}`]);
    sockets.push(ws);
    ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
    await new Promise((r) => ws.on('open', r));
    return msgs;
  };
  const [ownerMsgs, memberMsgs] = await Promise.all([listen(owner.token), listen(member.token)]);
  const t = (await start(owner, pageId)).data;
  await app.call('POST', `/comment-threads/${t.id}/replies`, owner.token, { body: 'more' });
  await app.call('PATCH', `/comment-threads/${t.id}`, owner.token, { resolved: true });
  await waitFor(() => ownerMsgs.filter((m) => m.type === 'comments' && m.pageId === pageId).length >= 3, 2000, 'owner events');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(memberMsgs.filter((m) => m.type === 'comments').length, 0, 'member received no comment events for the private page');
});
