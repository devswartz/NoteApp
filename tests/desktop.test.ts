// Desktop shell (Tauri): platform selection and the pure helpers behind the
// adapter, the menu, the badge, server setup and the release scripts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPlatform, loadPlatform } from '../src/platform/index.ts';
import { webPlatform } from '../src/platform/web.ts';
import type { Platform } from '../src/platform/types.ts';
import { readFileSync } from 'node:fs';
import { fallbackPath } from '../src/platform/tauri/paths.ts';
import { DESKTOP_SHORTCUTS } from '../src/platform/tauri/shortcuts.ts';
import { parseKeys } from '../src/hooks/useShortcuts.ts';
import { todayCount } from '../src/platform/tauri/badge.ts';
import { probeServer } from '../src/platform/tauri/serverSetup.ts';
import { SignedOut, describeFailure } from '../src/platform/tauri/captureErrors.ts';
import { createClickTracker } from '../src/platform/tauri/notificationClicks.ts';
import type { Task } from '../shared/types.ts';
// @ts-expect-error plain .mjs build scripts, no type declarations
import { manifest } from '../apps/desktop/scripts/latest-json.mjs';
// @ts-expect-error plain .mjs build scripts, no type declarations
import { appName, computedConfig } from '../apps/desktop/scripts/tauri.mjs';

test('detectPlatform: web by default, tauri when the Tauri globals exist', () => {
  assert.equal(detectPlatform(), 'web');
  const g = globalThis as Record<string, unknown>;
  g.__TAURI_INTERNALS__ = {};
  try {
    assert.equal(detectPlatform(), 'tauri');
  } finally {
    delete g.__TAURI_INTERNALS__;
  }
});

test('loadPlatform: loads the shell implementation lazily, web otherwise', async () => {
  const fake = { ...webPlatform, kind: 'tauri' } as Platform;
  let loaded = 0;
  const loaders = {
    tauri: async () => {
      loaded++;
      return fake;
    },
  };
  assert.equal(await loadPlatform('web', loaders), webPlatform);
  assert.equal(loaded, 0, 'the web build must not load the shell module');
  assert.equal(await loadPlatform('tauri', loaders), fake);
  assert.equal(loaded, 1);
  // No implementation yet (Capacitor) → web.
  assert.equal(await loadPlatform('capacitor', loaders), webPlatform);
});

test('menu fallback navigation', () => {
  assert.equal(fallbackPath('nav.today', '/w/ws1/p/abc'), '/w/ws1/tasks/today');
  assert.equal(fallbackPath('nav.completed', '/w/ws1/tasks/my'), '/w/ws1/tasks/completed');
  assert.equal(fallbackPath('nav.notes', '/w/ws1'), '/w/ws1/notes');
  assert.equal(fallbackPath('nav.today', '/login'), null);
  assert.equal(fallbackPath('pages.new', '/w/ws1'), null);
});

test('menu-less desktop (Windows/Linux): every macOS menu accelerator still has a shortcut', () => {
  const rust = readFileSync(new URL('../apps/desktop/src-tauri/src/menu.rs', import.meta.url), 'utf8');
  // ("pages.new", "New Page", Some("CmdOrCtrl+N")) → { command: 'pages.new', keys: 'mod+n' }
  const menu = [...rust.matchAll(/\("([\w.]+)",\s*"[^"]*",\s*Some\("CmdOrCtrl\+([^"]+)"\)\)/g)].map(([, command, accel]) => ({
    command,
    keys: `mod+${accel}`.toLowerCase(),
  }));
  assert.ok(menu.length >= 10, 'found the menu accelerators in menu.rs');
  // ⌘K and ⌘\ are handled by the web app itself (components/shell/commands.tsx).
  const inWebApp = new Set(['app.palette', 'app.sidebar']);
  for (const { command, keys } of menu) {
    if (inWebApp.has(command)) continue;
    assert.ok(
      DESKTOP_SHORTCUTS.some((d) => d.command === command && d.keys === keys),
      `${command} (${keys}) needs an entry in src/platform/tauri/shortcuts.ts`,
    );
  }
  // Settings and Quick Capture are declared separately in menu.rs; Settings is ⌘, on every platform.
  assert.ok(DESKTOP_SHORTCUTS.some((d) => d.command === 'nav.settings' && d.keys === 'mod+,'));
});

test('desktop shortcuts: valid key syntax, no duplicates', () => {
  const keys = DESKTOP_SHORTCUTS.map((d) => d.keys);
  assert.equal(new Set(keys).size, keys.length);
  for (const k of keys) {
    const [step] = parseKeys(k);
    assert.ok(step.mod, `${k} uses the platform modifier`);
  }
});

test('badge count: my open tasks due today or overdue', () => {
  const base = { status: 'open', assigneeId: null, createdBy: 'me', dueDate: '2026-11-05' } as Partial<Task>;
  const t = (o: Partial<Task>) => ({ ...base, ...o }) as Task;
  const tasks = [
    t({}), // today, mine (creator, unassigned)
    t({ dueDate: '2026-11-01' }), // overdue
    t({ dueDate: '2026-11-06' }), // tomorrow
    t({ dueDate: null }), // no date
    t({ status: 'done' }), // completed
    t({ assigneeId: 'sam' }), // someone else's
    t({ assigneeId: 'me', createdBy: 'sam' }), // assigned to me
  ];
  assert.equal(todayCount(tasks, 'me', '2026-11-05'), 3);
  assert.equal(todayCount(tasks, null, '2026-11-05'), 0);
});

test('probeServer accepts a Notivelo health response only', async () => {
  const urls: string[] = [];
  const ok = (async (u: string) => {
    urls.push(u);
    return new Response('{"ok":true,"version":"x"}', { status: 200 });
  }) as unknown as typeof fetch;
  assert.equal(await probeServer('notes.example.com/', ok), null);
  assert.deepEqual(urls, ['https://notes.example.com/api/health']);
  const html = (async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch;
  assert.match((await probeServer('https://x.y', html))!, /didn’t answer/);
  const down = (async () => {
    throw new TypeError('network');
  }) as unknown as typeof fetch;
  assert.match((await probeServer('https://x.y', down))!, /Couldn’t reach/);
});

test('tauri.mjs: app name from shared/config.ts, updater only with signing secrets', () => {
  assert.equal(appName("export const APP_NAME = 'Foo Notes';"), 'Foo Notes');
  const plain = computedConfig({});
  assert.equal(typeof plain.productName, 'string');
  assert.equal(plain.plugins, undefined);
  assert.equal(computedConfig({ TAURI_SIGNING_PRIVATE_KEY: 'k' }).plugins, undefined, 'needs the public key too');
  const signed = computedConfig({ TAURI_SIGNING_PRIVATE_KEY: 'k', TAURI_UPDATER_PUBKEY: 'pub', GITHUB_REPOSITORY: 'o/r', APP_VERSION: 'v1.2.3' });
  assert.equal(signed.version, '1.2.3');
  assert.equal(signed.bundle.createUpdaterArtifacts, true);
  assert.deepEqual(signed.plugins.updater, { pubkey: 'pub', endpoints: ['https://github.com/o/r/releases/latest/download/latest.json'] });
});

test('latest-json.mjs: lists signed bundles only', async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'bundles-'));
  mkdirSync(join(dir, 'mac'));
  mkdirSync(join(dir, 'win'));
  const mac = join(dir, 'mac', 'Notivelo.app.tar.gz');
  const exe = join(dir, 'win', 'Notivelo_1.2.3_x64-setup.exe');
  const msi = join(dir, 'win', 'Notivelo_1.2.3_x64_en-US.msi');
  for (const f of [mac, exe, msi]) writeFileSync(f, 'x');
  writeFileSync(`${mac}.sig`, 'SIGMAC\n');
  writeFileSync(`${exe}.sig`, 'SIGWIN');
  const m = manifest([mac, `${mac}.sig`, exe, `${exe}.sig`, msi], 'o/r', 'v1.2.3', new Date('2026-01-01T00:00:00Z'));
  assert.equal(m.version, '1.2.3');
  assert.deepEqual(m.platforms['darwin-aarch64'], { signature: 'SIGMAC', url: 'https://github.com/o/r/releases/download/v1.2.3/Notivelo.app.tar.gz' });
  assert.equal(m.platforms['darwin-x86_64'].url, m.platforms['darwin-aarch64'].url);
  assert.deepEqual(m.platforms['windows-x86_64'], { signature: 'SIGWIN', url: 'https://github.com/o/r/releases/download/v1.2.3/Notivelo_1.2.3_x64-setup.exe' });
  assert.deepEqual(manifest([mac, exe], 'o/r', 'v1.2.3').platforms, {}, 'unsigned bundles are not offered as updates');
});

test('notification clicks: coming to the front soon after a background notification runs its onClick', () => {
  const clicks: string[] = [];
  const t = createClickTracker(60_000);
  t.shown(() => clicks.push('a'), true, 1000);
  t.shown(() => clicks.push('b'), true, 2000); // the latest one wins
  assert.equal(t.focused(30_000), true);
  assert.deepEqual(clicks, ['b']);
  assert.equal(t.focused(31_000), false, 'only once');

  t.shown(() => clicks.push('c'), false, 40_000); // app was in front: the user saw it in-app
  assert.equal(t.focused(41_000), false);

  t.shown(() => clicks.push('d'), true, 50_000);
  assert.equal(t.focused(200_000), false, 'too late: an unrelated return to the app');
  assert.deepEqual(clicks, ['b']);
});

test('quick capture failure messages', () => {
  assert.match(describeFailure(new SignedOut(), true), /Sign in/);
  assert.match(describeFailure(new TypeError('Failed to fetch'), true), /offline/);
  assert.match(describeFailure(new Error('boom'), false), /offline/);
  assert.equal(describeFailure(new Error('Not allowed'), true), 'Not allowed');
});
