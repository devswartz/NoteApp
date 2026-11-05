// Generates the web/PWA icon set from public/icon.svg into public/icons/.
// Run after changing the icon (e.g. when the app is renamed):  npm run web:icons
// (The desktop and mobile shells have their own: npm run desktop:icons / mobile:icons.)
//
//   icon-192.png, icon-512.png        manifest "any" (the rounded icon, transparent corners)
//   maskable-192.png, maskable-512.png manifest "maskable" (full-bleed square; the glyph sits
//                                      inside the 80% safe zone, so any mask shape works)
//   apple-touch-icon.png (180)         iOS home screen: opaque square, iOS rounds it
//   favicon-16.png, favicon-32.png     browser tabs
//   favicon.ico (16, 32, 48)           legacy browsers and tools that only look for /favicon.ico
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public/icons');
mkdirSync(out, { recursive: true });

const svg = readFileSync(join(root, 'public/icon.svg'), 'utf8');
const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1] ?? '0 0 512 512';
const inner = svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const bg = /<rect[^>]*fill="([^"]+)"/.exec(svg)?.[1] ?? '#4f46e5';
const glyph = inner.replace(/<rect[^>]*\/>/, ''); // everything except the rounded background tile
const square = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"><rect x="-10000" y="-10000" width="20000" height="20000" fill="${bg}"/>${glyph}</svg>`;

const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test'); // root devDependency, already installed
const browser = await chromium.launch();
const page = await browser.newPage();
const render = async (markup, size, transparent) => {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${markup}`);
  return page.screenshot({ omitBackground: transparent, type: 'png' });
};

const files = {
  'icon-192.png': await render(svg, 192, true),
  'icon-512.png': await render(svg, 512, true),
  'maskable-192.png': await render(square, 192, false),
  'maskable-512.png': await render(square, 512, false),
  'apple-touch-icon.png': await render(square, 180, false),
  'favicon-16.png': await render(svg, 16, true),
  'favicon-32.png': await render(svg, 32, true),
};
const ico48 = await render(svg, 48, true);
await browser.close();

for (const [name, data] of Object.entries(files)) writeFileSync(join(out, name), data);

// favicon.ico with PNG-compressed entries (supported by every current browser and Windows Vista+).
const entries = [
  [16, files['favicon-16.png']],
  [32, files['favicon-32.png']],
  [48, ico48],
];
const header = Buffer.alloc(6 + 16 * entries.length);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(entries.length, 4);
let offset = header.length;
entries.forEach(([size, png], i) => {
  const e = 6 + i * 16;
  header.writeUInt8(size, e); // width (0 would mean 256)
  header.writeUInt8(size, e + 1); // height
  header.writeUInt8(0, e + 2); // palette size
  header.writeUInt8(0, e + 3); // reserved
  header.writeUInt16LE(1, e + 4); // colour planes
  header.writeUInt16LE(32, e + 6); // bits per pixel
  header.writeUInt32LE(png.length, e + 8);
  header.writeUInt32LE(offset, e + 12);
  offset += png.length;
});
writeFileSync(join(out, 'favicon.ico'), Buffer.concat([header, ...entries.map(([, png]) => png)]));

console.log(`Wrote ${Object.keys(files).length + 1} files to public/icons/ from public/icon.svg (background ${bg}).`);
