// Copies the web app's Lucide icons (docs/rewrite/look/icons/*.svg, see docs/rewrite/LOOK.md section 5)
// into apps/apple/Resources/Icons.xcassets as template vector images named "lucide-<name>".
// Each SVG gets its stroke attributes written onto every shape (Xcode's SVG renderer does not
// reliably inherit them from the root <svg> or understand currentColor). The colour is black: the
// assets render as templates, tinted by the view. Also writes "lucide-flag-filled" (the priority flag,
// filled as well as stroked). Run from the repo root: node apps/apple/scripts/bundle-icons.mjs
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../../..');
const src = path.join(root, 'docs/rewrite/look/icons');
const out = path.join(root, 'apps/apple/Resources/Icons.xcassets');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'Contents.json'), JSON.stringify({ info: { author: 'xcode', version: 1 } }, null, 2) + '\n');

const STROKE = 'fill="none" stroke="#000000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const FILLED = 'fill="#000000" stroke="#000000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

function convert(svg, attrs) {
  const body = svg
    .replace(/<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
    .replace(/<(path|circle|rect|line|polyline|polygon|ellipse)\b([^>]*?)\s*\/>/g, (_, tag, rest) => {
      const clean = rest.replace(/\s(fill|stroke|stroke-width|stroke-linecap|stroke-linejoin)="[^"]*"/g, '');
      return `<${tag}${clean} ${attrs}/>`;
    })
    .trim();
  return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">\n  ${body.split('\n').map((l) => l.trim()).filter(Boolean).join('\n  ')}\n</svg>\n`;
}

function write(name, svg) {
  const dir = path.join(out, `lucide-${name}.imageset`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, `${name}.svg`), svg);
  fs.writeFileSync(path.join(dir, 'Contents.json'), JSON.stringify({
    images: [{ filename: `${name}.svg`, idiom: 'universal' }],
    info: { author: 'xcode', version: 1 },
    properties: { 'preserves-vector-representation': true, 'template-rendering-intent': 'template' },
  }, null, 2) + '\n');
}

let n = 0;
for (const file of fs.readdirSync(src).filter((f) => f.endsWith('.svg')).sort()) {
  const name = file.slice(0, -4);
  const svg = fs.readFileSync(path.join(src, file), 'utf8');
  write(name, convert(svg, STROKE));
  if (name === 'flag') write('flag-filled', convert(svg, FILLED));
  n++;
}
console.log(`bundle-icons: ${n} icons into ${path.relative(root, out)}`);
