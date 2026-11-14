// Face ID / Touch ID for locked notes: the platform glue (src/platform/capacitor.ts createLockedNotesBiometrics) with
// fake BiometricAuth and SecureStorage plugins. The real iOS/Android path needs a device (see CHANGELOG).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLockedNotesBiometrics, lockedNotesKey } from '../src/platform/capacitor.ts';

function fakes(opts: { biometryType?: number; isAvailable?: boolean; fail?: string | null } = {}) {
  const store = new Map<string, string>();
  const calls: { reason?: string; allowDeviceCredential?: boolean }[] = [];
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
      getItem: async (k: string) => store.get(k) ?? null,
      setItem: async (k: string, v: string) => void store.set(k, v),
      removeItem: async (k: string) => void store.delete(k),
      setDefaultKeychainAccess: async () => {},
    },
  };
  return { native: native as never, store, calls, setFail: (f: string | null) => (fail = f) };
}

test('method: Face ID on an iPhone with Face ID; nothing on a passcode-only device', async () => {
  assert.equal(await createLockedNotesBiometrics(fakes({ biometryType: 2 }).native).method(), 'Face ID');
  assert.equal(await createLockedNotesBiometrics(fakes({ biometryType: 1 }).native).method(), 'Touch ID');
  assert.equal(await createLockedNotesBiometrics(fakes({ biometryType: 0 }).native).method(), null);
  assert.equal(await createLockedNotesBiometrics(fakes({ isAvailable: false }).native).method(), null);
});

test('save asks for biometrics first (no passcode fallback) and stores per user; read asks again', async () => {
  const f = fakes();
  const bio = createLockedNotesBiometrics(f.native);
  assert.equal(await bio.has('u1'), false);
  assert.deepEqual(await bio.read('u1'), { result: 'none' });
  assert.equal(f.calls.length, 0, 'nothing to read: no prompt');
  assert.equal(await bio.save('u1', { deviceId: 'd1', secret: 's1' }), true);
  assert.equal(f.calls.at(-1)?.allowDeviceCredential, false);
  assert.ok(f.store.has(lockedNotesKey('u1')));
  assert.equal(await bio.has('u1'), true);
  assert.equal(await bio.has('u2'), false, 'per user');
  assert.deepEqual(await bio.read('u1'), { result: 'ok', cred: { deviceId: 'd1', secret: 's1' } });
  assert.equal(f.calls.length, 2, 'read prompted again');
});

test('a cancelled or unavailable check stores nothing and hands back nothing', async () => {
  const f = fakes({ fail: 'userCancel' });
  const bio = createLockedNotesBiometrics(f.native);
  assert.equal(await bio.save('u1', { deviceId: 'd1', secret: 's1' }), false);
  assert.equal(f.store.size, 0);
  f.setFail(null);
  await bio.save('u1', { deviceId: 'd1', secret: 's1' });
  f.setFail('userCancel');
  assert.deepEqual(await bio.read('u1'), { result: 'cancelled' });
  f.setFail('biometryLockout');
  assert.deepEqual(await bio.read('u1'), { result: 'unavailable' });
});

test('forget removes the credential; garbage in the keychain counts as none', async () => {
  const f = fakes();
  const bio = createLockedNotesBiometrics(f.native);
  await bio.save('u1', { deviceId: 'd1', secret: 's1' });
  await bio.forget('u1');
  assert.equal(await bio.has('u1'), false);
  f.store.set(lockedNotesKey('u1'), 'not json');
  assert.equal(await bio.has('u1'), false);
  assert.deepEqual(await bio.read('u1'), { result: 'none' });
});
