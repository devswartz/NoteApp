// Test helper: starts the real server (API + collab WebSocket) on a random
// port with an in-memory SQLite database and a temporary DATA_DIR.
//
//   import { startTestApp } from './helpers/app.ts';
//   const app = await startTestApp();          // in before()
//   const alice = await app.signUp('Alice');   // { token, user, wsId }
//   const r = await app.call('GET', `/workspaces/${alice.wsId}/tree`, alice.token);
//   await app.close();                         // in after()
//
// node --test runs each test file in its own process, so each file gets a
// fresh database. Tests in one file share it: use unique names/emails.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { User } from '../../shared/types.ts';
import { signUploadPath, type FileKey } from '../../shared/fileLinks.ts';

export interface TestResponse<T> {
  status: number;
  data: T;
}

export interface TestUser {
  /** Access token. */
  token: string;
  refreshToken: string;
  user: User;
  /** The user's personal workspace, created at sign-up. */
  wsId: string;
  /** Key for signing upload links (shared/fileLinks.ts). */
  fileKey: FileKey;
}

export async function startTestApp() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'noteapp-test-'));
  // Must be set before the server modules are first imported.
  process.env.DB_FILE = ':memory:';
  process.env.JWT_SECRET ??= 'test-secret';
  process.env.SIGNUP_MODE ??= 'open'; // most tests create users freely; tests/signup.test.ts covers invite mode
  process.env.DATA_DIR = tmp;

  const { createServer } = await import('../../server/app.ts');
  const { server, collab, events } = createServer({ serveWeb: false });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function call<T = any>(method: string, url: string, token?: string, body?: unknown): Promise<TestResponse<T>> {
    const res = await fetch(`${origin}/api${url}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
  }

  let seq = 0;
  async function signUp(name: string, email = `${name.toLowerCase().replace(/\W+/g, '')}-${++seq}@example.com`): Promise<TestUser> {
    const r = await call('POST', '/auth/register', undefined, { name, email, password: 'password123' });
    if (r.status !== 200) throw new Error(`sign-up failed: ${r.status} ${JSON.stringify(r.data)}`);
    const ws = await call('GET', '/workspaces', r.data.accessToken);
    return { token: r.data.accessToken, refreshToken: r.data.refreshToken, user: r.data.user, wsId: ws.data[0].id, fileKey: r.data.fileKey };
  }

  /** Fetch an upload ("/uploads/<id><ext>") as `who`, with a signed link (or unsigned, without `who`). */
  function fetchFile(url: string, who?: { fileKey: FileKey }, init?: RequestInit) {
    return fetch(origin + (who ? signUploadPath(url, who.fileKey) : url), init);
  }

  async function close() {
    // Upgraded sockets aren't HTTP connections: end them too, or their ping timers keep the test process alive.
    for (const wss of [collab, events]) for (const c of wss.clients) c.terminate();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  return { origin, wsOrigin: origin.replace(/^http/, 'ws'), call, signUp, fetchFile, close };
}

export type TestApp = Awaited<ReturnType<typeof startTestApp>>;
