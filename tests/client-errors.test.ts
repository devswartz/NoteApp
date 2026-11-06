// POST /api/client-errors: public, rate limited, size capped, logged (never stored). Owner: Observability.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, type TestApp } from './helpers/app.ts';

let app: TestApp;
before(async () => {
  delete process.env.ADMIN_EMAILS;
  delete process.env.RATE_LIMIT_LOOPBACK;
  app = await startTestApp();
});
after(() => app.close());

const post = (body: unknown, headers: Record<string, string> = {}, raw?: string) =>
  fetch(`${app.origin}/api/client-errors`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw ?? JSON.stringify(body) });

/** Run `fn` and return the structured fields of every `client_error` log line written meanwhile (dev and production formats). */
async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; lines: Record<string, unknown>[]; raw: string }> {
  const lines: Record<string, unknown>[] = [];
  let raw = '';
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    const s = String(chunk);
    raw += s;
    for (const line of s.split('\n')) {
      if (!line.includes('client_error')) continue;
      const json = line.startsWith('{') ? line : line.slice(line.indexOf('{'));
      try {
        const o = JSON.parse(json) as Record<string, unknown>;
        if (o.event === 'client_error') lines.push(o);
      } catch {
        /* not ours */
      }
    }
    return true;
  }) as typeof process.stderr.write;
  try {
    return { result: await fn(), lines, raw };
  } finally {
    process.stderr.write = orig;
  }
}

const sample = { kind: 'error', message: 'boom', stack: 'Error: boom\n    at f (http://x/a.js:1:2)', source: 'http://x/a.js', line: 1, col: 2, url: 'http://x/', userAgent: 'UA/1', version: '9.9.9' };

test('anonymous report: 204, one warn line with the server and client versions, user null and the request id', async () => {
  const { result, lines } = await captureLogs(() => post(sample));
  assert.equal(result.status, 204);
  assert.equal(lines.length, 1);
  const l = lines[0]!;
  const { VERSION } = await import('../server/config.ts');
  assert.deepEqual(Object.keys(l).sort(), ['clientVersion', 'col', 'componentStack', 'event', 'kind', 'line', 'message', 'requestId', 'serverVersion', 'source', 'stack', 'url', 'userAgent', 'userId'].sort());
  assert.equal(l.event, 'client_error');
  assert.equal(l.serverVersion, VERSION);
  assert.equal(l.clientVersion, '9.9.9');
  assert.equal(l.userId, null);
  assert.equal(l.requestId, result.headers.get('x-request-id'));
  assert.equal(l.kind, 'error');
  assert.equal(l.message, 'boom');
  assert.equal(l.line, 1);
});

test('log level is warn (stderr) and the production line format carries level and event', async () => {
  // Same logger, so check the level via the dev prefix: warn lines start with "WARN client_error".
  const { raw } = await captureLogs(() => post(sample));
  assert.match(raw, /^WARN client_error \{|"level":"warn"/m);
});

test('a valid token records the user id; a bad or expired token is just anonymous', async () => {
  const u = await app.signUp('Reporter');
  const a = await captureLogs(() => post(sample, { authorization: `Bearer ${u.token}` }));
  assert.equal(a.result.status, 204);
  assert.equal(a.lines[0]!.userId, u.user.id);
  for (const bad of ['Bearer not-a-token', `Bearer ${u.token.slice(0, -3)}abc`, 'Basic abc', 'Bearer']) {
    const b = await captureLogs(() => post(sample, { authorization: bad }));
    assert.equal(b.result.status, 204, bad);
    assert.equal(b.lines[0]!.userId, null, bad);
  }
});

test('oversize body is refused with 413 and logs nothing', async () => {
  const { result, lines } = await captureLogs(() => post({ ...sample, stack: 'x'.repeat(20_000) }));
  assert.equal(result.status, 413);
  assert.equal(lines.length, 0);
});

test('invalid reports are 400: not an object, bad kind, missing message, bad JSON', async () => {
  assert.equal((await post([1, 2])).status, 400);
  assert.equal((await post({ ...sample, kind: 'other' })).status, 400);
  assert.equal((await post({ ...sample, message: '' })).status, 400);
  assert.equal((await post(null, {}, '{nope')).status, 400);
});

test('fields are truncated and typed; unknown fields are never logged', async () => {
  const { result, lines } = await captureLogs(() =>
    post({ kind: 'react', message: 'm'.repeat(700), stack: 's'.repeat(4500), componentStack: 'c'.repeat(2500), source: 'u'.repeat(900), url: 'http://x/'.padEnd(900, 'p'), userAgent: 'a'.repeat(900), version: 'v'.repeat(90), line: 'NaN', col: -4, password: 'hunter2', note: 'secret note' }),
  );
  assert.equal(result.status, 204);
  const l = lines[0]!;
  assert.equal((l.message as string).length, 500);
  assert.equal((l.stack as string).length, 4000);
  assert.equal((l.componentStack as string).length, 2000);
  for (const k of ['source', 'url', 'userAgent']) assert.equal((l[k] as string).length, 300, k);
  assert.equal((l.clientVersion as string).length, 40);
  assert.equal(l.line, null);
  assert.equal(l.col, null);
  assert.equal(l.kind, 'react');
  assert.doesNotMatch(JSON.stringify(l), /hunter2|secret note/);
});

test('query strings and fragments are stripped from the page url, the script url and URLs in the stack', async () => {
  const { lines } = await captureLogs(() =>
    post({
      ...sample,
      url: 'https://notes.example.com/reset?token=SECRET1#frag',
      source: 'https://notes.example.com/assets/a.js?v=SECRET2',
      stack: 'Error: x\n    at f (https://notes.example.com/assets/a.js?token=SECRET3:1:2)',
      message: 'load https://notes.example.com/x?key=SECRET4 failed',
    }),
  );
  const l = lines[0]!;
  assert.equal(l.url, 'https://notes.example.com/reset');
  assert.equal(l.source, 'https://notes.example.com/assets/a.js');
  assert.doesNotMatch(JSON.stringify(l), /SECRET\d/);
  const inv = await captureLogs(() => post({ ...sample, url: 'https://notes.example.com/invite/abcDEF123tok' }));
  assert.equal(inv.lines[0]!.url, 'https://notes.example.com/invite/:token');
});

test('nothing is persisted: row counts in every table are unchanged', async () => {
  const { db } = await import('../server/db.ts');
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((t) => t.name);
  const counts = () => tables.map((t) => (db.prepare(`SELECT count(*) AS n FROM "${t}"`).get() as { n: number }).n);
  const before = counts();
  assert.equal((await post(sample)).status, 204);
  assert.deepEqual(counts(), before);
});

test('rate limited per IP with 429 and Retry-After, and a refused report is not logged', async () => {
  const { resetRateLimits } = await import('../server/ratelimit.ts');
  resetRateLimits();
  process.env.RATE_LIMIT_LOOPBACK = '1'; // the test client is loopback, which is otherwise exempt
  try {
    const statuses: number[] = [];
    let last: Response | undefined;
    const { lines } = await captureLogs(async () => {
      for (let i = 0; i < 25; i++) {
        last = await post(sample);
        statuses.push(last.status);
      }
    });
    assert.equal(statuses.filter((s) => s === 204).length, 20);
    assert.equal(statuses.at(-1), 429);
    assert.ok(Number(last!.headers.get('retry-after')) >= 1);
    assert.equal(lines.length, 20);
  } finally {
    delete process.env.RATE_LIMIT_LOOPBACK;
    resetRateLimits();
  }
});

test('a server-wide cap applies across IPs (unit)', async () => {
  const { takeClientError, resetRateLimits, LIMITS } = await import('../server/ratelimit.ts');
  resetRateLimits();
  process.env.RATE_LIMIT_LOOPBACK = '1';
  try {
    const fake = (ip: string) => ({ socket: { remoteAddress: ip }, get: () => undefined }) as never;
    let allowed = 0;
    for (let i = 0; i < LIMITS.clientErrorGlobal.capacity + 10; i++) if (takeClientError(fake(`10.0.${i % 250}.${Math.floor(i / 250)}`)) === 0) allowed++;
    assert.equal(allowed, LIMITS.clientErrorGlobal.capacity);
    assert.ok(takeClientError(fake('10.9.9.9')) >= 1);
  } finally {
    delete process.env.RATE_LIMIT_LOOPBACK;
    resetRateLimits();
  }
});
