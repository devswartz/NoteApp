// Renders the app icon and splash sources from public/icon.svg into
// apps/mobile/assets/, then generates every iOS/Android size with
// @capacitor/assets. Run after changing the icon:  npm run mobile:icons
import { readFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const mobile = join(here, '..');
const out = join(mobile, 'assets');
mkdirSync(out, { recursive: true });

const svg = readFileSync(join(mobile, '../../public/icon.svg'), 'utf8');
const inner = svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const bg = /<rect[^>]*fill="([^"]+)"/.exec(svg)?.[1] ?? '#4f46e5';
const glyph = inner.replace(/<rect[^>]*\/>/, ''); // everything but the rounded background

// iOS masks the icon itself, so the source is square and opaque.
const square = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="${bg}"/>${glyph}</svg>`;
// Android adaptive icons: the glyph must sit in the inner 66% safe zone.
const foreground = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-128 -128 768 768">${glyph}</svg>`;
const background = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="${bg}"/></svg>`;
const splash = (paper) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2732 2732"><rect width="2732" height="2732" fill="${paper}"/><g transform="translate(1110 1110) scale(1)">${inner}</g></svg>`;

const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test'); // root devDependency
const browser = await chromium.launch();
const page = await browser.newPage();
const render = async (name, markup, size, transparent = false) => {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${markup}`);
  await page.screenshot({ path: join(out, name), omitBackground: transparent });
};
await render('icon-only.png', square, 1024);
await render('icon-foreground.png', foreground, 1024, true);
await render('icon-background.png', background, 1024);
await render('splash.png', splash('#ffffff'), 2732);
await render('splash-dark.png', splash('#18181b'), 2732);
await browser.close();

if (!process.argv.includes('--sources-only')) {
  execSync(
    `npx --yes @capacitor/assets@4.0.0 generate --ios --android --assetPath assets --iconBackgroundColor '${bg}' --iconBackgroundColorDark '${bg}' --splashBackgroundColor '#ffffff' --splashBackgroundColorDark '#18181b'`,
    { cwd: mobile, stdio: 'inherit' },
  );
}
