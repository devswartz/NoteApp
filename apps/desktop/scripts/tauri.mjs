#!/usr/bin/env node
// Runs the Tauri CLI for apps/desktop with config that is computed rather than
// hard-coded in tauri.conf.json:
//   - the version from APP_VERSION (CI: the tag), else package.json;
//   - productName from APP_NAME in shared/config.ts (the app will be renamed there);
//   - the updater (endpoint + public key, signed update artifacts) only when
//     TAURI_SIGNING_PRIVATE_KEY and TAURI_UPDATER_PUBKEY are set, so builds without
//     secrets still work, just unsigned and without auto-update.
// Empty signing variables (GitHub passes "" for secrets that don't exist) are
// removed, so the bundler skips signing instead of failing on them.
//
//   node apps/desktop/scripts/tauri.mjs dev | build [tauri args…]
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, '..');
const root = join(desktop, '..', '..');

export function appName(source = readFileSync(join(root, 'shared/config.ts'), 'utf8')) {
  const m = source.match(/export const APP_NAME\s*=\s*['"]([^'"]+)['"]/);
  if (!m) throw new Error('APP_NAME not found in shared/config.ts');
  return m[1];
}

export function computedConfig(env = process.env) {
  const config = { productName: appName() };
  // CI sets APP_VERSION from the tag (v1.2.3 → 1.2.3); otherwise package.json's version is used.
  if (env.APP_VERSION) config.version = env.APP_VERSION.replace(/^v/, '');
  if (env.TAURI_SIGNING_PRIVATE_KEY && env.TAURI_UPDATER_PUBKEY) {
    const repo = env.GITHUB_REPOSITORY || 'devswartz/NoteApp';
    config.bundle = { createUpdaterArtifacts: true };
    config.plugins = {
      updater: {
        pubkey: env.TAURI_UPDATER_PUBKEY,
        // "latest" skips drafts: an update reaches users when the draft release is published.
        endpoints: [env.TAURI_UPDATER_ENDPOINT || `https://github.com/${repo}/releases/latest/download/latest.json`],
      },
    };
  }
  return config;
}

const SIGNING_VARS = [
  'TAURI_SIGNING_PRIVATE_KEY',
  'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
  'TAURI_UPDATER_PUBKEY',
  'APPLE_CERTIFICATE',
  'APPLE_CERTIFICATE_PASSWORD',
  'APPLE_SIGNING_IDENTITY',
  'APPLE_ID',
  'APPLE_PASSWORD',
  'APPLE_TEAM_ID',
  'APPLE_API_KEY',
  'APPLE_API_ISSUER',
  'APPLE_API_KEY_PATH',
];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = { ...process.env };
  for (const k of SIGNING_VARS) if (!env[k]) delete env[k];
  // A key without a password still needs the variable (empty), or the CLI prompts for one.
  if (env.TAURI_SIGNING_PRIVATE_KEY) env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= '';
  const [cmd = 'dev', ...rest] = process.argv.slice(2);
  const args = [cmd, '--config', JSON.stringify(computedConfig(env)), ...rest];
  const bin = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tauri.cmd' : 'tauri');
  const r = spawnSync(bin, args, { cwd: desktop, env, stdio: 'inherit', shell: process.platform === 'win32' });
  process.exit(r.status ?? 1);
}
