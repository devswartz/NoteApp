// iOS update prompt: version comparison, the client's check logic, and GET /api/app/version.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, parseVersion, type AppVersionInfo } from '../shared/appVersion.ts';
import { CHECK_EVERY_MS, createStoreUpdates } from '../src/platform/storeUpdates.ts';
import { startTestApp, type TestApp } from './helpers/app.ts';

test('compareVersions orders versions numerically and ignores build suffixes', () => {
  assert.ok(compareVersions('0.5.10', '0.5.9') > 0);
  assert.ok(compareVersions('0.5.3', '0.6') < 0);
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
  assert.equal(compareVersions('v1.2.3', '1.2.3 (45)'), 0);
  assert.equal(compareVersions('garbage', '1.0'), 0, 'unparseable never triggers anything');
  assert.equal(parseVersion(''), null);
});

function setup(info: AppVersionInfo | null, installed = '0.5.3') {
  let t = 0;
  const opened: string[] = [];
  let fetches = 0;
  const u = createStoreUpdates({
    installed: async () => installed,
    fetchInfo: async () => {
      fetches++;
      return info;
    },
    openStore: (url) => void opened.push(url),
    now: () => t,
  });
  return { u, opened, fetches: () => fetches, advance: (ms: number) => void (t += ms), set: (i: AppVersionInfo | null) => void (info = i) };
}
const STORE = 'https://apps.apple.com/app/id123';

test('a newer store version is offered once, and Update opens the App Store', async () => {
  const s = setup({ latest: '0.5.4', minimum: null, storeUrl: STORE });
  const offers: (() => void)[] = [];
  s.u.subscribe((apply) => offers.push(apply));
  await s.u.check();
  assert.equal(offers.length, 1);
  offers[0]();
  assert.deepEqual(s.opened, [STORE]);
  await s.u.check(true);
  assert.equal(offers.length, 1, 'the same version is not offered again');
  const late: unknown[] = [];
  s.u.subscribe((apply) => late.push(apply));
  assert.equal(late.length, 1, 'a late subscriber still hears about it');
});

test('the same or an older store version (e.g. a TestFlight build) offers nothing', async () => {
  for (const latest of ['0.5.3', '0.5.2', null]) {
    const s = setup({ latest, minimum: null, storeUrl: STORE });
    let offered = false;
    s.u.subscribe(() => (offered = true));
    await s.u.check();
    assert.equal(offered, false, `latest=${latest}`);
  }
});

test('below the minimum: required (blocking), not the ordinary offer', async () => {
  const s = setup({ latest: '0.6.0', minimum: '0.6.0', storeUrl: STORE });
  let offered = false;
  const required: (() => void)[] = [];
  s.u.subscribe(() => (offered = true));
  s.u.subscribeRequired((open) => required.push(open));
  await s.u.check();
  assert.equal(offered, false);
  assert.equal(required.length, 1);
  required[0]();
  assert.deepEqual(s.opened, [STORE]);
});

test('checks are throttled, and failures are silent', async () => {
  const s = setup(null);
  await s.u.check();
  await s.u.check();
  assert.equal(s.fetches(), 1, 'a second foreground soon after does not ask again');
  s.advance(CHECK_EVERY_MS);
  await s.u.check();
  assert.equal(s.fetches(), 2);

  const broken = createStoreUpdates({
    installed: async () => '0.5.3',
    fetchInfo: async () => {
      throw new Error('offline');
    },
    openStore: () => assert.fail('nothing to open'),
  });
  await broken.check(); // resolves, never throws
});

test('no store link means nothing is offered', async () => {
  const s = setup({ latest: '9.9.9', minimum: '9.9.9', storeUrl: null });
  let heard = false;
  s.u.subscribe(() => (heard = true));
  s.u.subscribeRequired(() => (heard = true));
  await s.u.check();
  assert.equal(heard, false);
});

// --- GET /api/app/version ---------------------------------------------------------------

let app: TestApp;
let setStoreLookup: typeof import('../server/routes/appVersion.ts').setStoreLookup;
before(async () => {
  app = await startTestApp();
  ({ setStoreLookup } = await import('../server/routes/appVersion.ts'));
});
after(() => {
  setStoreLookup();
  delete process.env.MIN_APP_VERSION_IOS;
  return app.close();
});

test('GET /api/app/version reports the store version and minimum without auth, cached', async () => {
  let lookups = 0;
  setStoreLookup(async () => {
    lookups++;
    return { version: '0.5.4', url: STORE };
  });
  process.env.MIN_APP_VERSION_IOS = '0.5.0';
  const r = await app.call('GET', '/app/version?os=ios');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { latest: '0.5.4', minimum: '0.5.0', storeUrl: STORE });
  await app.call('GET', '/app/version?os=ios');
  assert.equal(lookups, 1, 'Apple is asked once, then the cached answer is served');

  const android = await app.call('GET', '/app/version?os=android');
  assert.deepEqual(android.data, { latest: null, minimum: null, storeUrl: null });
});

test('GET /api/app/version: a failed lookup gives nulls (or the last good answer), never an error', async () => {
  setStoreLookup(async () => {
    throw new Error('Apple is down');
  });
  delete process.env.MIN_APP_VERSION_IOS;
  const r = await app.call('GET', '/app/version?os=ios');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { latest: null, minimum: null, storeUrl: null });

  process.env.MIN_APP_VERSION_IOS = 'not-a-version';
  const bad = await app.call('GET', '/app/version?os=ios');
  assert.equal((bad.data as AppVersionInfo).minimum, null, 'a malformed minimum is ignored');
});
