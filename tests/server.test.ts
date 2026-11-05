// Server tests run against an in-memory database. Env must be set before the
// server modules are imported, so they are loaded with dynamic import().
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import * as Y from 'yjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'noteapp-test-'));
process.env.DB_FILE = ':memory:';
process.env.JWT_SECRET = 'test-secret';
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');

let server: http.Server;
let base = '';

before(async () => {
  const express = (await import('express')).default;
  const { api } = await import('../server/routes.ts');
  const app = express();
  app.use('/api', api);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

after(() => {
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function call<T = any>(method: string, url: string, token?: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as T };
}

async function signUp(name: string) {
  const r = await call('POST', '/auth/register', undefined, { name, email: `${name.toLowerCase()}@example.com`, password: 'password123' });
  assert.equal(r.status, 200);
  const ws = await call('GET', '/workspaces', r.data.token);
  return { token: r.data.token as string, wsId: ws.data[0].id as string };
}

test('sign-up creates a personal workspace with an onboarding tree', async () => {
  const { token, wsId } = await signUp('Alice');
  const tree = await call('GET', `/workspaces/${wsId}/tree`, token);
  assert.equal(tree.status, 200);
  assert.ok(tree.data.notebooks.length >= 1);
  assert.ok(tree.data.pages.length >= 1);
});

test('requests without a token are rejected', async () => {
  assert.equal((await call('GET', '/workspaces')).status, 401);
});

test('a task can be created with an empty title (inline "[] " tasks)', async () => {
  const { token, wsId } = await signUp('Bob');
  const r = await call('POST', `/workspaces/${wsId}/tasks`, token, { title: '' });
  assert.equal(r.status, 200);
  assert.equal(r.data.title, '');
});

test('saving a page reconciles which tasks it references', async () => {
  const { token, wsId } = await signUp('Carol');
  const { syncPageTasks, getTask } = await import('../server/tasks.ts');
  const { extractDoc } = await import('../server/collab.ts');
  const tree = await call('GET', `/workspaces/${wsId}/tree`, token);
  const sectionId = tree.data.sections[0].id;
  const page = await call('POST', `/sections/${sectionId}/pages`, token, { title: 'Plan' });
  const pageId = page.data.id as string;

  const a = (await call('POST', `/workspaces/${wsId}/tasks`, token, { title: 'A', pageId })).data.id as string;
  const b = (await call('POST', `/workspaces/${wsId}/tasks`, token, { title: 'B' })).data.id as string;

  // The note now embeds B (e.g. pasted in) but no longer contains A.
  const doc = new Y.Doc();
  const frag = doc.getXmlFragment('default');
  const p = new Y.XmlElement('paragraph');
  p.insert(0, [new Y.XmlText('Hello')]);
  const ref = new Y.XmlElement('taskRef');
  ref.setAttribute('taskId', b);
  frag.insert(0, [p, ref]);
  const { text, taskIds } = extractDoc(frag);
  assert.equal(text, 'Hello');
  assert.deepEqual([...taskIds], [b]);

  syncPageTasks(pageId, wsId, taskIds);
  assert.equal(getTask(a)!.pageId, null, 'removed task becomes standalone, not deleted');
  assert.equal(getTask(b)!.pageId, pageId, 'referenced task is linked to the page');
});

test('completing a task records who completed it', async () => {
  const { token, wsId } = await signUp('Dan');
  const t = (await call('POST', `/workspaces/${wsId}/tasks`, token, { title: 'Ship it' })).data;
  const done = await call('PATCH', `/tasks/${t.id}`, token, { status: 'done' });
  assert.equal(done.data.status, 'done');
  assert.ok(done.data.completedAt);
});
