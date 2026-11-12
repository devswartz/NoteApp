// Shared helpers for the store-asset scripts (see capture.cjs). Demo data only.
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:4517';
const PASSWORD = process.env.DEMO_PASSWORD || 'demo-pass-123';

async function api(path, token) {
  const r = await fetch(BASE + '/api' + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return r.json();
}

/** Ids of the Demo Team workspace and its demo pages, found by title. */
async function ids() {
  const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'demo@example.com', password: PASSWORD }) });
  const s = await r.json();
  const ws = (await api('/workspaces', s.accessToken)).find((w) => w.name === 'Demo Team');
  const tree = await api(`/workspaces/${ws.id}/tree`, s.accessToken);
  const page = (title) => tree.pages.find((p) => p.title.startsWith(title))?.id;
  const section = (name) => tree.sections.find((x) => x.name === name)?.id;
  return { ws: ws.id, page, section, token: s.accessToken };
}

/** theme: light | dark | hybrid. accent: an id from src/store/ui.ts (default blue). */
async function newContext(browser, { theme = 'light', accent = 'blue', ...opts }) {
  const ctx = await browser.newContext({ colorScheme: theme === 'dark' ? 'dark' : 'light', reducedMotion: 'reduce', ...opts });
  await ctx.addInitScript(([t, a]) => {
    try {
      localStorage.setItem('noteapp.theme', t);
      localStorage.setItem('noteapp.accent', a);
    } catch {}
  }, [theme, accent]);
  return ctx;
}

async function signIn(page) {
  await page.goto(BASE + '/login');
  await page.getByLabel('Email').fill('demo@example.com');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/w\//);
  await page.waitForTimeout(1500);
}

module.exports = { chromium, BASE, ids, newContext, signIn };
