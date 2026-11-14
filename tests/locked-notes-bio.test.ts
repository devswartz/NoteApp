// Face ID / Touch ID for locked notes: the platform glue (src/platform/capacitor.ts createLockedNotesBiometrics) with
// fake BiometricAuth, SecureStorage and kv. The real iOS/Android path needs a device.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLockedNotesBiometrics, lockedNotesKey, lockedNotesMarker } from '../src/platform/capacitor.ts';

function fakes(opts: { biometryType?: number; isAvailable?: boolean; fail?: string | null; withSet?: boolean } = {}) {
  const store = new Map<string, string>();
  const access = new Map<string, number | undefined>();
  const reads: string[] = [];
  const calls: { reason?: string; allowDeviceCredential?: boolean }[] = [];
  const kvMap = new Map<string, string>();
  let fail = opts.fail ?? null;
  const native = {
    os: 'ios' as const,
    BiometricAuth: {
      checkBiometry: async () => ({ isAvailable: opts.isAvailable ?? true, biometryType: opts.biometryType ?? 2, deviceIsSecure: true }),
      authenticate: async (o?: { reason?: string; allowDeviceCredential?: boolean }) => {
        calls.push(o ?? {});
        if (fail) throw Object.assign(new Error(fail), { code: fail });
      },
    },
    SecureStorage: {
      getItem: async (k: string) => (reads.push(k), store.get(k) ?? null),
      setItem: async (k: string, v: string) => void store.set(k, v),
      removeItem: async (k: string) => void store.delete(k),
      setDefaultKeychainAccess: async () => {},
      ...(opts.withSet === false
        ? {}
        : {
            set: async (k: string, v: unknown, _c?: boolean, _s?: boolean, a?: number) => {
              store.set(k, String(v));
              access.set(k, a);
            },
          }),
    },
  };
  const kv = { get: (k: string) => kvMap.get(k) ?? null, set: (k: string, v: string) => void kvMap.set(k, v), remove: (k: string) => void kvMap.delete(k) };
  return { native: native as never, kv, store, access, reads, calls, kvMap, setFail: (f: string | null) => (fail = f) };
}
const make = (f: ReturnType<typeof fakes>) => createLockedNotesBiometrics(f.native, f.kv);

test('method: Face ID / Touch ID; nothing on a passcode-only device or without biometrics', async () => {
  assert.equal(await make(fakes({ biometryType: 2 })).method(), 'Face ID');
  assert.equal(await make(fakes({ biometryType: 1 })).method(), 'Touch ID');
  assert.equal(await make(fakes({ biometryType: 0 })).method(), null);
  assert.equal(await make(fakes({ isAvailable: false })).method(), null);
});

test('save asks for biometrics first (no passcode fallback), stores this-device-only, and sets only a marker in kv', async () => {
  const f = fakes();
  const bio = make(f);
  assert.equal(await bio.save('u1', { deviceId: 'd1', secret: 's1' }), true);
  assert.equal(f.calls.at(-1)?.allowDeviceCredential, false);
  assert.equal(f.access.get(lockedNotesKey('u1')), 4, 'whenPasscodeSetThisDeviceOnly');
  assert.equal(f.kvMap.get(lockedNotesMarker('u1')), '1');
  assert.ok(![...f.kvMap.values()].some((v) => v.includes('s1')), 'the secret is never in kv');
});

test('has() never touches the keychain or prompts; read() prompts before reading the secret', async () => {
  const f = fakes();
  const bio = make(f);
  await bio.save('u1', { deviceId: 'd1', secret: 's1' });
  const prompts = f.calls.length;
  f.reads.length = 0;
  assert.equal(await bio.has('u1'), true);
  assert.equal(await bio.has('u2'), false);
  assert.equal(f.reads.length, 0, 'no keychain read');
  assert.equal(f.calls.length, prompts, 'no prompt');
  f.setFail('userCancel');
  assert.deepEqual(await bio.read('u1'), { result: 'cancelled' });
  assert.equal(f.reads.length, 0, 'a cancelled prompt reads nothing');
  f.setFail(null);
  assert.deepEqual(await bio.read('u1'), { result: 'ok', cred: { deviceId: 'd1', secret: 's1' } });
  assert.equal(f.reads.length, 1);
});

test('cancelled or unavailable checks store nothing; forget clears marker and secret; a lost secret clears the marker', async () => {
  const f = fakes({ fail: 'userCancel', withSet: false });
  const bio = make(f);
  assert.equal(await bio.save('u1', { deviceId: 'd1', secret: 's1' }), false);
  assert.equal(f.store.size, 0);
  assert.equal(await bio.has('u1'), false);
  f.setFail(null);
  await bio.save('u1', { deviceId: 'd1', secret: 's1' });
  f.setFail('biometryLockout');
  assert.deepEqual(await bio.read('u1'), { result: 'unavailable' });
  f.setFail(null);
  await bio.forget('u1');
  assert.equal(await bio.has('u1'), false);
  assert.equal(f.store.size, 0);
  assert.deepEqual(await bio.read('u1'), { result: 'none' });
  // Marker without a secret (keychain wiped, e.g. passcode removed): none, and the marker goes.
  f.kvMap.set(lockedNotesMarker('u1'), '1');
  assert.deepEqual(await bio.read('u1'), { result: 'none' });
  assert.equal(await bio.has('u1'), false);
});
