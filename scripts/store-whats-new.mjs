// "What's New" text for an App Store version (iOS and macOS get the same text). Used by .github/workflows/store-submit.yml.
//
//   node scripts/store-whats-new.mjs v0.5.4 [--whats-new docs/store/whats-new.md] [--changelog CHANGELOG.md] [--explain] [--section-only]
//
// Prints the text on stdout; warnings go to stderr as GitHub `::warning::` lines. Sources, in order:
//   1. The `## v0.5.4` section of docs/store/whats-new.md (format documented at the top of that file). Used as written,
//      with Markdown emphasis/links/code removed. Over 4000 characters is an error: it was written by hand, so fix it there.
//   2. Otherwise the `## v0.5.4` entry of CHANGELOG.md, trimmed to user-facing bullets: sections such as "Behind the scenes"
//      are dropped, and so is any bullet that reads as developer notes (code, env variables, scripts, review notes...). Each
//      bullet is shortened to its first sentence or two. If most of the entry is developer-facing, or nothing is left, the
//      generic line below is used instead, with a warning, so internal notes never reach the store.
//   3. No entry anywhere: the generic line, with a warning.
// --section-only: use only source 1; with no section, print nothing and exit 3 (tag pushes: no section = no store release).
// --explain prints which bullets were kept or dropped (stderr), for checking the heuristics.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const LIMIT = 4000;
export const GENERIC = 'Bug fixes and improvements to make Notivelo faster and more reliable.';

// Whole changelog subsections that are never user-facing.
const DEV_SECTIONS = /behind the scenes|monitoring|internal|developer|infrastructure|\bci\b|build|server|docs|documentation|chatgpt directory|store/i;
// A bullet containing any of these reads as developer notes.
const DEV_MARKERS = [
  [/`[^`]+`/, 'inline code'],
  [/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/, 'env variable'],
  [/(^|\s)#\d+\b|\bPR\b|pull request/i, 'PR reference'],
  [/\b(lawyer|legal review|TODO|FIXME|WIP|internal|staging|seed|fixture|script|endpoint|webhook|migration|refactor|dependenc(y|ies)|CI|workflow|secrets?)\b/i, 'internal wording'],
  [/^\s*(server|api|admin)\s*:/i, 'server note'],
  [/\.well-known|\/[a-z]+\/[a-z]|\b[\w-]+\.(ts|tsx|js|mjs|json|yml|md|plist)\b/i, 'path or file'],
];

/** Markdown → plain text for the store. */
export function plain(md) {
  return md
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s*\(#\d+\)/g, '')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const norm = (v) => v.replace(/^v/i, '');

/** The body of the `## vX.Y.Z` (or `## X.Y.Z`, optionally followed by text) section, or null. */
export function section(md, version) {
  const want = norm(version);
  const lines = md.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = /^##\s+v?(\d+\.\d+\.\d+)\b/.exec(lines[i]);
    if (start >= 0 && /^##\s/.test(lines[i])) return lines.slice(start, i).join('\n').trim();
    if (m && m[1] === want) start = i + 1;
  }
  return start >= 0 ? lines.slice(start).join('\n').trim() : null;
}

/** First one or two sentences, at most `max` characters, cut at a sentence or word boundary. */
function shorten(text, max = 280) {
  const sentences = text.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
  let out = sentences[0];
  // A short bold lead-in ("Lock a page.") says little on its own: add the next sentence.
  if (out.length < 60 && sentences[1]) out += ' ' + sentences[1];
  if (out.length > max) out = out.slice(0, max).replace(/\s+\S*$/, '') + '…';
  return out;
}

/** User-facing text from a CHANGELOG entry: { text, kept, dropped, devFacing }. */
export function fromChangelog(body) {
  const groups = []; // { title, bullets: [] }
  const kept = [];
  const dropped = [];
  let current = { title: '', skip: false, bullets: [] };
  groups.push(current);
  for (const line of body.split(/\r?\n/)) {
    const h = /^###\s+(.+)/.exec(line);
    if (h) {
      current = { title: h[1].trim(), skip: DEV_SECTIONS.test(h[1]), bullets: [] };
      groups.push(current);
      continue;
    }
    const b = /^-\s+(.+)/.exec(line); // top-level bullets only; nested ones are detail
    if (!b) continue;
    const raw = b[1];
    const why = current.skip ? `section "${current.title}"` : DEV_MARKERS.find(([re]) => re.test(raw))?.[1];
    if (why) {
      dropped.push({ section: current.title, why, text: raw });
      continue;
    }
    const text = shorten(plain(raw));
    kept.push({ section: current.title, text });
    current.bullets.push(text);
  }
  const total = kept.length + dropped.length;
  const devFacing = kept.length === 0 || dropped.length / total > 0.5;
  const parts = [];
  let length = 0;
  let truncated = false;
  const more = '• …and more improvements.';
  const used = groups.filter((g) => g.bullets.length);
  const titled = used.length > 1;
  for (const g of used) {
    const lines = g.bullets.map((t) => `• ${t}`);
    let block = (titled && g.title ? `${plain(g.title)}\n` : '') + lines[0];
    const pieces = [block, ...lines.slice(1)];
    for (const [i, piece] of pieces.entries()) {
      const sep = i === 0 ? (parts.length ? '\n\n' : '') : '\n';
      if (length + sep.length + piece.length + more.length + 1 > LIMIT) {
        truncated = true;
        break;
      }
      parts.push(sep + piece);
      length += sep.length + piece.length;
    }
    if (truncated) break;
  }
  if (truncated) parts.push('\n' + more);
  return { text: parts.join('').trim(), kept, dropped, devFacing, truncated };
}

/** { text, source, warnings } for a version. */
export function whatsNew(version, { whatsNewPath = 'docs/store/whats-new.md', changelogPath = 'CHANGELOG.md', sectionOnly = false } = {}) {
  const warnings = [];
  if (existsSync(whatsNewPath)) {
    const body = section(readFileSync(whatsNewPath, 'utf8').replace(/<!--[\s\S]*?-->/g, ''), version);
    if (body !== null) {
      const text = plain(body);
      if (!text) throw new Error(`${whatsNewPath}: the section for v${norm(version)} is empty`);
      if (text.length > LIMIT) throw new Error(`${whatsNewPath}: the text for v${norm(version)} is ${text.length} characters; App Store Connect allows ${LIMIT}`);
      return { text, source: whatsNewPath, warnings };
    }
  }
  if (sectionOnly) return null;
  if (existsSync(changelogPath)) {
    const body = section(readFileSync(changelogPath, 'utf8'), version);
    if (body !== null) {
      const r = fromChangelog(body);
      if (r.devFacing) {
        warnings.push(`${changelogPath} v${norm(version)} reads as developer notes (${r.dropped.length} of ${r.kept.length + r.dropped.length} bullets are internal); using the generic What's New line. Add a "## v${norm(version)}" section to ${whatsNewPath} for real release notes.`);
        return { text: GENERIC, source: 'generic', warnings, detail: r };
      }
      if (r.dropped.length) warnings.push(`What's New for v${norm(version)} comes from ${changelogPath} with ${r.dropped.length} developer-facing bullet(s) left out. Check the text, or write it in ${whatsNewPath}.`);
      if (r.truncated) warnings.push(`What's New for v${norm(version)} was cut to fit ${LIMIT} characters.`);
      return { text: r.text, source: changelogPath, warnings, detail: r };
    }
  }
  warnings.push(`No v${norm(version)} entry in ${whatsNewPath} or ${changelogPath}; using the generic What's New line.`);
  return { text: GENERIC, source: 'generic', warnings };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
  const version = args.find((a, i) => !a.startsWith('--') && !['--whats-new', '--changelog'].includes(args[i - 1]));
  if (!version || !/^v?\d+\.\d+\.\d+$/.test(version)) {
    console.error('::error::usage: node scripts/store-whats-new.mjs vX.Y.Z [--whats-new file] [--changelog file] [--explain] [--section-only]');
    process.exit(2);
  }
  try {
    const r = whatsNew(version, { whatsNewPath: opt('--whats-new', 'docs/store/whats-new.md'), changelogPath: opt('--changelog', 'CHANGELOG.md'), sectionOnly: args.includes('--section-only') });
    if (!r) {
      console.error(`No What's New section for v${version.replace(/^v/, '')} in ${opt('--whats-new', 'docs/store/whats-new.md')}.`);
      process.exit(3);
    }
    for (const w of r.warnings) console.error(`::warning::${w}`);
    if (args.includes('--explain') && r.detail) {
      for (const k of r.detail.kept) console.error(`kept    [${k.section}] ${k.text.slice(0, 100)}`);
      for (const d of r.detail.dropped) console.error(`dropped [${d.section}] (${d.why}) ${d.text.slice(0, 100)}`);
    }
    console.error(`What's New source: ${r.source}, ${r.text.length} characters.`);
    process.stdout.write(r.text + '\n');
  } catch (e) {
    console.error(`::error::${e.message}`);
    process.exit(1);
  }
}
