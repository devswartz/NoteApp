import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APP_ROWS, deviceOS } from '../src/components/GetTheApps.tsx';

test('deviceOS reads the platform from the user agent (iPadOS reports as a Mac with touch)', () => {
  assert.equal(deviceOS('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15'), 'mac');
  assert.equal(deviceOS('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 5), 'ios');
  assert.equal(deviceOS('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'), 'ios');
  assert.equal(deviceOS('Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/131'), 'android');
  assert.equal(deviceOS('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131'), 'windows');
  assert.equal(deviceOS('Mozilla/5.0 (X11; Linux x86_64)'), 'other');
});

test('every app link is https on notiveloapp.com or the App Store, under the stable installer names', () => {
  for (const r of APP_ROWS) {
    for (const href of [r.href, r.extra?.href].filter(Boolean) as string[]) {
      assert.match(href, /^https:\/\/(notiveloapp\.com|apps\.apple\.com)\//, href);
    }
  }
  const hrefs = APP_ROWS.flatMap((r) => [r.href, r.extra?.href]);
  for (const f of ['Notivelo-mac.dmg', 'Notivelo-windows-setup.exe', 'Notivelo-windows.msi']) {
    assert.ok(hrefs.includes(`https://notiveloapp.com/download/${f}`), f);
  }
});
