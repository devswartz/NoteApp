// Exports every Lucide icon the web app uses as a standalone SVG, for the native apps' asset
// catalogs (docs/rewrite/LOOK.md, "Icons"). Reads the icon node data of the installed
// lucide-react (no extra package needed) and the imports in src/.
//   node docs/rewrite/look/export-icons.mjs
// Writes docs/rewrite/look/icons/<kebab-name>.svg and docs/rewrite/look/icons/index.md.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const LUCIDE = path.join(ROOT, 'node_modules/lucide-react/dist/esm');
const OUT = path.join(HERE, 'icons');
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/lucide-react/package.json'), 'utf8')).version;

// Export name → icon module, from lucide-react's index.
const fileOf = new Map();
for (const m of fs.readFileSync(path.join(LUCIDE, 'lucide-react.mjs'), 'utf8').matchAll(/export \{([^}]*)\} from '\.\/icons\/([a-z0-9-]+)\.mjs'/g)) {
  for (const part of m[1].split(',')) {
    const name = part.trim().split(/\s+as\s+/).pop();
    if (name) fileOf.set(name, m[2]);
  }
}

// Every lucide-react import in src/, with the sizes it is drawn at.
const uses = new Map(); // icon file → { names:Set, files:Set, sizes:Set, strokes:Set }
const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(tsx?|ts)$/.test(e.name) ? [path.join(dir, e.name)] : []));
for (const file of walk(path.join(ROOT, 'src'))) {
  const src = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  for (const m of src.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*'lucide-react'/g)) {
    for (const raw of m[1].split(',')) {
      const [imported, local = imported] = raw.trim().split(/\s+as\s+/).map((s) => s.trim());
      if (!imported || !fileOf.has(imported)) continue;
      const key = fileOf.get(imported);
      const u = uses.get(key) ?? { names: new Set(), files: new Set(), sizes: new Set(), strokes: new Set() };
      u.names.add(imported);
      u.files.add(rel);
      for (const s of src.matchAll(new RegExp(`<${local}\\b([^>]*)>`, 'g'))) {
        const size = s[1].match(/size=\{(\d+(?:\.\d+)?)\}/)?.[1];
        const stroke = s[1].match(/strokeWidth=\{(\d+(?:\.\d+)?)\}/)?.[1];
        u.sizes.add(size ?? (s[1].includes('size=') ? 'var' : 'css'));
        if (stroke) u.strokes.add(stroke);
      }
      // Passed as a component (icon: Sun) and drawn elsewhere.
      if (!new RegExp(`<${local}\\b`).test(src)) u.sizes.add('via prop');
      uses.set(key, u);
    }
  }
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const attr = (o) => Object.entries(o).filter(([k]) => k !== 'key').map(([k, v]) => `${k}="${v}"`).join(' ');
const rows = [];
for (const key of [...uses.keys()].sort()) {
  const mod = await import(pathToFileURL(path.join(LUCIDE, 'icons', `${key}.mjs`)).href);
  const nodes = mod.__iconData.node;
  const body = nodes.map(([tag, a]) => `  <${tag} ${attr(a)} />`).join('\n');
  fs.writeFileSync(
    path.join(OUT, `${key}.svg`),
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">\n${body}\n</svg>\n`,
  );
  const u = uses.get(key);
  rows.push(`| \`${key}.svg\` | ${[...u.names].join(', ')} | ${[...u.sizes].sort().join(', ')}${u.strokes.size ? ` (stroke ${[...u.strokes].join(', ')})` : ''} | ${[...u.files].sort().map((f) => `\`${f.replace(/^src\//, '')}\``).join(', ')} |`);
}
fs.writeFileSync(
  path.join(OUT, 'index.md'),
  `# Lucide icons used by the web app\n\nlucide-react ${version}. ${rows.length} icons, exported by \`../export-icons.mjs\` from the package's icon data: 24×24 viewBox, \`stroke="currentColor"\`, stroke width 2 (in 24ths of the icon: at size 16 the line is 1.33 px), round caps and joins, no fill. Sizes are the \`size={…}\` props in the source ("css": no size prop, the CSS sets it, e.g. ribbon buttons 18 px; "via prop": passed as a component and sized where drawn). See \`docs/rewrite/LOOK.md\`, Icons.\n\n| SVG | Imported as | Sizes (px) | Used in (src/) |\n|---|---|---|---|\n${rows.join('\n')}\n`,
);
console.log(`${rows.length} icons → ${path.relative(ROOT, OUT)}`);
