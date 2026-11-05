#!/usr/bin/env node
// Writes the Tauri updater manifest (latest.json) for a release from the
// bundles CI built. Only signed bundles (with a .sig next to them) are listed;
// with no signing key the manifest has no platforms and CI doesn't upload it.
//
//   node apps/desktop/scripts/latest-json.mjs <bundles dir> <owner/repo> <tag>
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** GitHub stores asset names with spaces (and other odd characters) as dots. */
const assetName = (file) => basename(file).replace(/[^\w.+-]/g, '.');

export function manifest(files, repo, tag, now = new Date()) {
  const url = (f) => `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName(f))}`;
  const signed = (suffix) => files.filter((f) => f.endsWith(suffix) && files.includes(`${f}.sig`));
  const entry = (f) => ({ signature: readFileSync(`${f}.sig`, 'utf8').trim(), url: url(f) });
  const platforms = {};
  // One universal macOS bundle serves both architectures.
  const mac = signed('.app.tar.gz')[0];
  if (mac) platforms['darwin-aarch64'] = platforms['darwin-x86_64'] = entry(mac);
  const win = signed('-setup.exe')[0] ?? signed('.msi')[0];
  if (win) platforms['windows-x86_64'] = entry(win);
  return {
    version: tag.replace(/^v/, ''),
    notes: `See https://github.com/${repo}/releases/tag/${tag}`,
    pub_date: now.toISOString(),
    platforms,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, repo, tag] = process.argv.slice(2);
  if (!dir || !repo || !tag) {
    console.error('usage: latest-json.mjs <bundles dir> <owner/repo> <tag>');
    process.exit(2);
  }
  process.stdout.write(JSON.stringify(manifest(walk(dir), repo, tag), null, 2) + '\n');
}
