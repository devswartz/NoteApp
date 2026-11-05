// Screenshots for README.md and the keyboard-shortcut list for docs/USER_GUIDE.md.
// Run against a production build with demo data:
//   npm run build
//   SEED_DEMO=1 DEMO_PASSWORD=demo-pass-123 DATA_DIR=/tmp/noteapp-docs PORT=3005 JWT_SECRET=<32+ chars> NODE_ENV=production npx tsx server/index.ts
//   BASE=http://localhost:3005 DEMO_PASSWORD=demo-pass-123 node scripts/docs-screenshots.cjs
// Writes docs/images/*.png and prints the shortcuts (from the `?` overlay, i.e. the command registry) as Markdown.
const { chromium, devices } = require('playwright');
const path = require('path');
const BASE = process.env.BASE || 'http://localhost:3005';
const PASSWORD = process.env.DEMO_PASSWORD || 'demo-pass-123';
const out = (n) => path.join(__dirname, '..', 'docs', 'images', n);

async function signIn(page) {
  await page.goto(BASE + '/login');
  await page.getByLabel('Email').fill('demo@example.com');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/w\//);
  await page.waitForTimeout(1500);
}

const day = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Adds a few realistic tasks to the demo user's first workspace (throwaway demo data only). */
async function seedTasks() {
  const post = async (p, body, token) => {
    const r = await fetch(BASE + '/api' + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`${p}: ${r.status} ${await r.text()}`);
    return r.json();
  };
  const s = await post('/auth/login', { email: 'demo@example.com', password: PASSWORD });
  const ws = (await (await fetch(BASE + '/api/workspaces', { headers: { Authorization: `Bearer ${s.accessToken}` } })).json())[0].id;
  const tasks = [
    { title: 'Send Q4 invoice to Acme', dueDate: day(0), priority: 1 },
    { title: 'Review onboarding copy', dueDate: day(0), priority: 2, dueTime: '15:00' },
    { title: 'Renew domain', dueDate: day(-1), priority: 2 },
    { title: 'Plan team offsite agenda', dueDate: day(2), priority: 3 },
    { title: 'Water the office plants', dueDate: day(1), priority: 4, recurrence: { freq: 'week', interval: 1 } },
    { title: 'Draft release notes', dueDate: day(4), priority: 2 },
    { title: 'Book dentist', dueDate: day(9), priority: 4 },
  ];
  for (const t of tasks) await post(`/workspaces/${ws}/tasks`, { ...t, assigneeId: s.user.id }, s.accessToken).catch((e) => console.warn('seed:', e.message));
}

(async () => {
  if (!process.env.NO_SEED) await seedTasks();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' });
  const page = await ctx.newPage();
  await signIn(page);
  const ws = page.url().match(/\/w\/([^/]+)/)[1];

  // A note with embedded tasks (the onboarding page).
  await page.getByText('Welcome', { exact: false }).first().click();
  await page.waitForTimeout(2000);
  await page.screenshot({ path: out('notes.png') });

  await page.goto(`${BASE}/w/${ws}/tasks/today`);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: out('today.png') });

  await page.goto(`${BASE}/w/${ws}/tasks/calendar`);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: out('calendar.png') });

  // Keyboard shortcuts from the `?` overlay.
  await page.goto(`${BASE}/w/${ws}/tasks/today`);
  await page.waitForTimeout(1000);
  await page.keyboard.press('?');
  await page.waitForTimeout(800);
  const dialog = page.getByRole('dialog').last();
  const text = await dialog.innerText().catch(() => '');
  console.log('----- SHORTCUT OVERLAY TEXT -----\n' + text);
  await page.screenshot({ path: out('shortcuts.png') });

  const mctx = await browser.newContext({ ...devices['iPhone 15'], colorScheme: 'light' });
  const m = await mctx.newPage();
  await signIn(m);
  const mws = m.url().match(/\/w\/([^/]+)/)[1];
  await m.goto(`${BASE}/w/${mws}/tasks/today`);
  await m.waitForTimeout(1500);
  await m.screenshot({ path: out('mobile.png') });

  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
