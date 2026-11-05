import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startTestApp, type TestApp } from './helpers/app.ts';

let app: TestApp;
before(async () => {
  process.env.GIT_SHA = 'abc1234';
  app = await startTestApp();
});
after(() => app.close());

test('GET /api/health reports ok and the build version without auth', async () => {
  const r = await app.call('GET', '/health');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { ok: true, version: 'abc1234' });
});

function nextMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    ws.once('message', (d) => resolve(JSON.parse(String(d))));
    ws.once('error', reject);
  });
}

test('/api/events WebSocket pushes task changes to workspace members', async () => {
  const alice = await app.signUp('Alice');
  const ws = new WebSocket(`${app.wsOrigin}/api/events?token=${alice.token}`);
  await new Promise((r) => ws.once('open', r));
  const msg = nextMessage(ws);
  const created = await app.call('POST', `/workspaces/${alice.wsId}/tasks`, alice.token, { title: 'Live' });
  const ev = (await msg) as { type: string; task: { id: string } };
  assert.equal(ev.type, 'task');
  assert.equal(ev.task.id, created.data.id);
  ws.close();
});

test('/api/events rejects a missing token', async () => {
  const ws = new WebSocket(`${app.wsOrigin}/api/events`);
  const code = await new Promise<number>((r) => ws.once('close', (c) => r(c)));
  assert.equal(code, 4401);
});
