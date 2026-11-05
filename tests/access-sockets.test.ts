// Live sockets lose access when roles/membership change, and close when their token expires.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { WebSocket } from 'ws';
import { startTestApp, type TestApp } from './helpers/app.ts';

let app: TestApp;
before(async () => {
  app = await startTestApp();
});
after(() => app.close());

const closeCode = (ws: WebSocket) => new Promise<number>((r) => ws.once('close', (c) => r(c)));
const opened = (ws: WebSocket) => new Promise((r) => ws.once('message', r));

async function sharedPage() {
  const owner = await app.signUp('Owner');
  const guest = await app.signUp('Guest');
  await app.call('POST', `/workspaces/${owner.wsId}/members`, owner.token, { email: guest.user.email, role: 'member' });
  const tree = await app.call('GET', `/workspaces/${owner.wsId}/tree`, owner.token);
  return { owner, guest, pageId: tree.data.pages[0].id as string };
}

test('removing a member closes their open collab socket (4403)', async () => {
  const { owner, guest, pageId } = await sharedPage();
  const ws = new WebSocket(`${app.wsOrigin}/collab/${pageId}`, ['noteapp.v1', `bearer.${guest.token}`]);
  await opened(ws);
  const closed = closeCode(ws);
  await app.call('DELETE', `/workspaces/${owner.wsId}/members/${guest.user.id}`, owner.token);
  assert.equal(await closed, 4403);
});

test('making a notebook private closes other members’ sockets', async () => {
  const { owner, guest, pageId } = await sharedPage();
  const tree = await app.call('GET', `/workspaces/${owner.wsId}/tree`, owner.token);
  const ws = new WebSocket(`${app.wsOrigin}/collab/${pageId}`, ['noteapp.v1', `bearer.${guest.token}`]);
  await opened(ws);
  const closed = closeCode(ws);
  await app.call('PATCH', `/notebooks/${tree.data.notebooks[0].id}`, owner.token, { visibility: 'private' });
  assert.equal(await closed, 4403);
});

test('a socket closes with 4401 when its access token expires', async () => {
  const u = await app.signUp('Short');
  const tree = await app.call('GET', `/workspaces/${u.wsId}/tree`, u.token);
  const shortToken = () => jwt.sign({ sub: u.user.id, typ: 'access' }, 'test-secret', { expiresIn: 2 });

  const events = new WebSocket(`${app.wsOrigin}/api/events`, ['noteapp.v1', `bearer.${shortToken()}`]);
  assert.equal(await closeCode(events), 4401);

  const collab = new WebSocket(`${app.wsOrigin}/collab/${tree.data.pages[0].id}`, ['noteapp.v1', `bearer.${shortToken()}`]);
  await opened(collab);
  // Closed by the socket's own expiry timer, without waiting for the 30 s sweep.
  assert.equal(await closeCode(collab), 4401);
});
