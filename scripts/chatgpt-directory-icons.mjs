// Exports the ChatGPT Directory logo from public/icon.svg into docs/store/chatgpt-directory/.
// Run after changing the icon:  node scripts/chatgpt-directory-icons.mjs
//
//   logo.svg                 full-bleed square (indigo tile, white page and tick), square viewBox
//   logo-512.png, logo-1024.png  the same, opaque PNG (ChatGPT applies its own rounding/mask)
//   logo-rounded-512.png     the rounded app icon with transparent corners, in case a rounded file is wanted
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'docs/store/chatgpt-directory');
mkdirSync(out, { recursive: true });

const svg = readFileSync(join(root, 'public/icon.svg'), 'utf8');
const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1] ?? '0 0 512 512';
const [, , vw, vh] = viewBox.split(/\s+/).map(Number);
const inner = svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const bg = /<rect[^>]*fill="([^"]+)"/.exec(svg)?.[1] ?? '#4f46e5';
const glyph = inner.replace(/<rect[^>]*\/>/, '');
const square = `<svg xmlns="http://www.w3.org/2000/svg" width="${vw}" height="${vh}" viewBox="${viewBox}"><rect width="${vw}" height="${vh}" fill="${bg}"/>${glyph}</svg>`;

const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test');
const browser = await chromium.launch();
const page = await browser.newPage();
const render = async (markup, size, transparent) => {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${markup}`);
  return page.screenshot({ omitBackground: transparent, type: 'png' });
};
const files = {
  'logo-512.png': await render(square, 512, false),
  'logo-1024.png': await render(square, 1024, false),
  'logo-rounded-512.png': await render(svg, 512, true),
};
await browser.close();

writeFileSync(join(out, 'logo.svg'), square + '\n');
for (const [name, data] of Object.entries(files)) writeFileSync(join(out, name), data);
console.log(`Wrote logo.svg and ${Object.keys(files).length} PNGs to docs/store/chatgpt-directory/ (background ${bg}).`);
