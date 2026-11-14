// Captures the app for the README (docs/screens/readme-*.png) and the raw phone/tablet
// screenshots the App Store compositor uses (RAW_DIR, default ./.store-raw).
//   node scripts/store-assets/capture.cjs desktop|mobile|all
// Needs a server with the demo data on BASE (see docs/store/README notes in app-store-listing.md).
const path = require('path');
const fs = require('fs');
const { chromium, ids, newContext, signIn, BASE } = require('./lib.cjs');

const SCREENS = path.join(__dirname, '..', '..', 'docs', 'screens');
const RAW = process.env.RAW_DIR || path.join(__dirname, '.store-raw');
fs.mkdirSync(RAW, { recursive: true });

async function settle(page, ms = 1800) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(ms);
}

async function desktop(browser, I) {
  const modes = [
    ['light', { theme: 'light' }],
    ['hybrid', { theme: 'hybrid', accent: 'teal' }],
    ['dark', { theme: 'dark', accent: 'purple' }],
  ];
  for (const [name, o] of modes) {
    const ctx = await newContext(browser, { ...o, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await signIn(page);
    await page.goto(`${BASE}/w/${I.ws}/p/${I.page('Project brief')}`);
    await settle(page);
    await page.screenshot({ path: path.join(SCREENS, `readme-${name}.png`) });
    if (name === 'light') {
      await page.goto(`${BASE}/w/${I.ws}/p/${I.page('Site structure')}`);
      await settle(page);
      await page.screenshot({ path: path.join(SCREENS, 'readme-outline.png') });
      await page.goto(`${BASE}/w/${I.ws}/tasks/upcoming`);
      await settle(page);
      await page.screenshot({ path: path.join(SCREENS, 'readme-tasks.png') });
      await page.goto(`${BASE}/w/${I.ws}/tasks/calendar`);
      await settle(page);
      await page.screenshot({ path: path.join(SCREENS, 'readme-calendar.png') });
    }
    await ctx.close();
  }
}

/** README phone screenshots: 390x844 at 3x. */
async function readmeMobile(browser, I) {
  const ctx = await newContext(browser, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await signIn(page);
  for (const [n, url] of [['mobile-page', `/p/${I.page('Kickoff meeting')}`], ['mobile-tasks', '/tasks/upcoming']]) {
    await page.goto(BASE + `/w/${I.ws}` + url);
    await settle(page);
    await page.screenshot({ path: path.join(SCREENS, `readme-${n}.png`) });
  }
  await ctx.close();
}

async function mobile(browser, I) {
  const devices = [
    ['iphone', { viewport: { width: 440, height: 956 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }],
    ['ipad', { viewport: { width: 1032, height: 1376 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
  ];
  const shots = [
    ['page-brief', 'light', `/p/${I.page('Project brief')}`],
    ['page-kickoff', 'light', `/p/${I.page('Kickoff meeting')}`],
    ['page-outline', 'light', `/p/${I.page('Site structure')}`],
    ['tasks-today', 'light', '/tasks/today'],
    ['tasks-upcoming', 'light', '/tasks/upcoming'],
    ['calendar', 'light', '/tasks/calendar'],
    ['page-dark', 'dark', `/p/${I.page('Project brief')}`],
    ['page-hybrid', 'hybrid', `/p/${I.page('Kickoff meeting')}`],
  ];
  for (const [dname, d] of devices) {
    for (const theme of ['light', 'dark', 'hybrid']) {
      const ctx = await newContext(browser, { ...d, theme, accent: theme === 'hybrid' ? 'teal' : 'blue' });
      const page = await ctx.newPage();
      await signIn(page);
      if (theme === 'light') {
        // Share dialog on the brief, and an empty page showing "Start with a template".
        await page.goto(`${BASE}/w/${I.ws}/p/${I.page('Project brief')}`);
        await settle(page);
        await page.getByRole('button', { name: /^Share/ }).first().click();
        await settle(page, 1200);
        await page.screenshot({ path: path.join(RAW, `${dname}-share.png`) });
        const r = await fetch(`${BASE}/api/sections/${I.section('Design')}/pages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${I.token}` }, body: '{"title":""}' });
        const np = (await r.json()).id;
        await page.goto(`${BASE}/w/${I.ws}/p/${np}`);
        await settle(page);
        await page.screenshot({ path: path.join(RAW, `${dname}-template-picker.png`) });
        await fetch(`${BASE}/api/pages/${np}`, { method: 'DELETE', headers: { Authorization: `Bearer ${I.token}` } });
      }
      for (const [n, t, url] of shots) {
        if (t !== theme) continue;
        await page.goto(BASE + `/w/${I.ws}` + url);
        await settle(page);
        await page.screenshot({ path: path.join(RAW, `${dname}-${n}.png`) });
      }
      await ctx.close();
    }
  }
}

/**
 * Mac App Store raw shots (mac-*.png): a desktop window, 1440x900 CSS at 2x, no touch.
 * The Mac app is the same web UI in a Tauri window; the web build shows no install prompt or
 * browser-only banner in these views, so only transient toasts (.toasts) are hidden.
 */
const MAC_HIDE = '.toasts { display: none !important; }';
async function mac(browser, I) {
  const d = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 };
  const shots = [
    ['page-brief', 'light', `/p/${I.page('Project brief')}`],
    ['page-kickoff', 'light', `/p/${I.page('Kickoff meeting')}`],
    ['tasks-upcoming', 'light', '/tasks/upcoming'],
    ['page-dark', 'dark', `/p/${I.page('Project brief')}`],
    ['page-hybrid', 'hybrid', `/p/${I.page('Kickoff meeting')}`],
  ];
  const shot = async (page, n) => {
    await page.addStyleTag({ content: MAC_HIDE });
    await page.mouse.move(0, 899); // no hover state on whatever sits under the cursor
    await page.screenshot({ path: path.join(RAW, `mac-${n}.png`) });
  };
  for (const theme of ['light', 'dark', 'hybrid']) {
    const ctx = await newContext(browser, { ...d, theme, accent: theme === 'hybrid' ? 'teal' : 'blue' });
    const page = await ctx.newPage();
    await signIn(page);
    if (theme === 'light') {
      await page.goto(`${BASE}/w/${I.ws}/p/${I.page('Project brief')}`);
      await settle(page);
      await page.getByRole('button', { name: /^Share/ }).first().click();
      await settle(page, 1200);
      await shot(page, 'share');
      const r = await fetch(`${BASE}/api/sections/${I.section('Design')}/pages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${I.token}` }, body: '{"title":""}' });
      const np = (await r.json()).id;
      await page.goto(`${BASE}/w/${I.ws}/p/${np}`);
      await settle(page);
      await shot(page, 'template-picker');
      await fetch(`${BASE}/api/pages/${np}`, { method: 'DELETE', headers: { Authorization: `Bearer ${I.token}` } });
    }
    for (const [n, t, url] of shots) {
      if (t !== theme) continue;
      await page.goto(BASE + `/w/${I.ws}` + url);
      await settle(page);
      await shot(page, n);
    }
    await ctx.close();
  }
}

(async () => {
  const what = process.argv[2] || 'all';
  const I = await ids();
  const browser = await chromium.launch();
  if (what === 'desktop' || what === 'all') await desktop(browser, I);
  if (what === 'mobile' || what === 'all') await mobile(browser, I);
  if (what === 'mac' || what === 'all') await mac(browser, I);
  if (what === 'readme-mobile' || what === 'all') await readmeMobile(browser, I);
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
