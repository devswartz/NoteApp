// Production-only rules, checked against a real server process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

function startProd(env: Record<string, string>) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noteapp-prod-'));
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    env: { ...process.env, NODE_ENV: 'production', DATA_DIR: dataDir, DB_FILE: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const exited = new Promise<number | null>((r) => child.once('exit', (c) => r(c)));
  const listening = new Promise<void>((resolve, reject) => {
    child.stdout.on('data', () => out.includes('listening') && resolve());
    void exited.then(() => reject(new Error(out)));
  });
  listening.catch(() => {}); // awaited only by tests that expect the server to start
  return { child, exited, listening, output: () => out, cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true }) };
}

test('production refuses a JWT_SECRET shorter than 32 bytes', async () => {
  const p = startProd({ JWT_SECRET: 'too-short', PORT: '0' });
  assert.equal(await p.exited, 1);
  assert.match(p.output(), /at least 32 bytes/);
  p.cleanup();
});

test('production ignores ?token= on WebSockets (subprotocol only)', async () => {
  const port = String(40000 + Math.floor(Math.random() * 20000));
  const p = startProd({ JWT_SECRET: 'x'.repeat(48), PORT: port });
  try {
    await p.listening;
    const base = `http://127.0.0.1:${port}`;
    const r = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Prod', email: 'prod@example.com', password: 'password123' }),
    });
    const { accessToken } = (await r.json()) as { accessToken: string };
    const viaQuery = new WebSocket(`ws://127.0.0.1:${port}/api/events?token=${accessToken}`);
    assert.equal(await new Promise((res) => viaQuery.once('close', (c) => res(c))), 4401);
    const viaProtocol = new WebSocket(`ws://127.0.0.1:${port}/api/events`, ['noteapp.v1', `bearer.${accessToken}`]);
    await new Promise((res, rej) => (viaProtocol.once('open', res), viaProtocol.once('close', rej)));
    viaProtocol.close();
  } finally {
    p.child.kill('SIGTERM');
    await p.exited;
    p.cleanup();
  }
});
