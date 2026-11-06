// Native push server side (server/reminders/apns.ts, devices). Owner: Mobile.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startTestApp, type TestApp } from './helpers/app.ts';
import type { Notice } from '../server/reminders/channels.ts';

let app: TestApp;
before(async () => {
  app = await startTestApp();
});
after(() => app.close());

const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const cfg = (host: string) => ({
  keyId: 'KEY1234567',
  teamId: 'TEAM123456',
  bundleId: 'com.devswartz.notivelo',
  privateKey: ec.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  host,
});

test('device tokens: register, move to the account that signs in, delete', async () => {
  const a = await app.signUp('PushA');
  const b = await app.signUp('PushB');
  const token = 'd'.repeat(64);
  assert.equal((await app.call('POST', '/notifications/devices', a.token, { platform: 'ios', token })).status, 200);
  assert.equal((await app.call('POST', '/notifications/devices', a.token, { platform: 'ios', token })).status, 200, 'idempotent');
  assert.equal((await app.call('POST', '/notifications/devices', undefined, { platform: 'ios', token })).status, 401);
  assert.equal((await app.call('POST', '/notifications/devices', a.token, { platform: 'ios', token: 'short' })).status, 400);
  const { deviceTokens } = await import('../server/reminders/devices.ts');
  assert.deepEqual(deviceTokens(a.user.id, 'ios'), [token]);
  // The same install signs in as B: the token follows B, A stops getting B's device.
  assert.equal((await app.call('POST', '/notifications/devices', b.token, { platform: 'ios', token })).status, 200);
  assert.deepEqual(deviceTokens(a.user.id, 'ios'), []);
  assert.deepEqual(deviceTokens(b.user.id, 'ios'), [token]);
  // A can't delete B's token.
  await app.call('DELETE', '/notifications/devices', a.token, { token });
  assert.deepEqual(deviceTokens(b.user.id, 'ios'), [token]);
  assert.equal((await app.call('DELETE', '/notifications/devices', b.token, { token })).status, 200);
  assert.deepEqual(deviceTokens(b.user.id, 'ios'), []);
});

test('APNs: sandbox (Xcode) and production (TestFlight) tokens both delivered; the working host is remembered', async () => {
  const { apnsChannel, APNS_HOSTS } = await import('../server/reminders/apns.ts');
  const { deliver } = await import('../server/reminders/deliver.ts');
  const u = await app.signUp('PushEnv');
  const prodToken = 'a'.repeat(64);
  const devToken = 'b'.repeat(64);
  const deadToken = 'c'.repeat(64);
  for (const token of [prodToken, devToken, deadToken])
    assert.equal((await app.call('POST', '/notifications/devices', u.token, { platform: 'ios', token })).status, 200);

  // A fake APNs: each token is valid in one environment only; deadToken in neither.
  const validOn: Record<string, string> = { [prodToken]: APNS_HOSTS.production, [devToken]: APNS_HOSTS.sandbox };
  const reqs: { host: string; token: string }[] = [];
  const apns = apnsChannel(async (req) => {
    const token = req.path.split('/').pop()!;
    reqs.push({ host: req.host, token });
    return validOn[token] === req.host ? { status: 200, body: '' } : { status: 400, body: JSON.stringify({ reason: 'BadDeviceToken' }) };
  }, () => cfg(APNS_HOSTS.production));

  const notice = (key: string): Notice => ({ key, userId: u.user.id, title: 'Pay rent', body: 'Due today', path: '/w/1/tasks/today' });
  const r1 = await deliver(notice('env-1'), [apns]);
  assert.deepEqual([r1.sent, r1.failed], [2, 1], 'prod + sandbox delivered, the bad one failed');
  const hostsFor = (token: string) => reqs.filter((r) => r.token === token).map((r) => r.host);
  assert.deepEqual(hostsFor(prodToken), [APNS_HOSTS.production]);
  assert.deepEqual(hostsFor(devToken), [APNS_HOSTS.production, APNS_HOSTS.sandbox], 'retried on sandbox');
  assert.deepEqual(hostsFor(deadToken), [APNS_HOSTS.production, APNS_HOSTS.sandbox]);
  assert.ok(!apns.targets(u.user.id).includes(deadToken), 'a token bad in both environments is forgotten');

  reqs.length = 0;
  const r2 = await deliver(notice('env-2'), [apns]);
  assert.equal(r2.sent, 2);
  assert.deepEqual(hostsFor(devToken), [APNS_HOSTS.sandbox], 'next time it goes straight to sandbox');
});

test('/.well-known: universal-link and app-link files, public JSON, 404 until configured', async () => {
  const { appleAppSiteAssociation, assetLinks, normalizeFingerprint, wellKnownConfig } = await import('../server/wellKnown.ts');
  const fp = 'ab'.repeat(32);
  assert.equal(normalizeFingerprint(fp), 'AB:'.repeat(31) + 'AB');
  assert.equal(normalizeFingerprint('AB:CD'), null);
  const c = wellKnownConfig({ APNS_TEAM_ID: 'ABCDE12345', ANDROID_CERT_SHA256: `${fp}, nonsense ,${'CD:'.repeat(31)}CD` });
  assert.deepEqual(appleAppSiteAssociation(c)!.applinks.details[0].appIDs, ['ABCDE12345.com.devswartz.notivelo']);
  assert.deepEqual(appleAppSiteAssociation(c)!.applinks.details[0].components, [{ '/': '/w/*', comment: 'Workspace pages and tasks' }]);
  assert.equal(assetLinks(c)![0].target.package_name, 'com.devswartz.notivelo');
  assert.equal(assetLinks(c)![0].target.sha256_cert_fingerprints.length, 2, 'invalid fingerprints dropped');
  assert.equal(appleAppSiteAssociation(wellKnownConfig({ APNS_TEAM_ID: 'bad id' })), null);

  // Over HTTP: the test server has neither configured, then both.
  for (const path of ['/.well-known/apple-app-site-association', '/.well-known/assetlinks.json'])
    assert.equal((await fetch(app.origin + path)).status, 404, path);
  process.env.APNS_TEAM_ID = 'ABCDE12345';
  process.env.ANDROID_CERT_SHA256 = fp;
  try {
    const aasa = await fetch(app.origin + '/.well-known/apple-app-site-association', { redirect: 'manual' });
    assert.equal(aasa.status, 200);
    assert.match(aasa.headers.get('content-type')!, /^application\/json/);
    assert.equal((await aasa.json()).applinks.details[0].appIDs[0], 'ABCDE12345.com.devswartz.notivelo');
    const links = await fetch(app.origin + '/.well-known/assetlinks.json');
    assert.equal(links.status, 200);
    assert.match(links.headers.get('content-type')!, /^application\/json/);
    assert.equal((await links.json())[0].target.sha256_cert_fingerprints[0], normalizeFingerprint(fp));
  } finally {
    delete process.env.APNS_TEAM_ID;
    delete process.env.ANDROID_CERT_SHA256;
  }
});
