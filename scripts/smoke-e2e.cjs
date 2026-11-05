// Manual browser smoke test of the core flow (sign up → notebook/section/page → type →
// inline task → Today → complete → done in note). Run with `npm run dev` up:
//   node scripts/smoke-e2e.cjs            (BASE=http://localhost:3001 for npm start)
// Uses the preinstalled Playwright. The QA agent's tests/e2e suite will supersede this.
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:5173';
const shot = (p, n) => p.screenshot({ path: require('path').join(require('os').tmpdir(), `noteapp-smoke-${n}.png`) });
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  page.on('dialog', async (d) => {
    const answers = { 'Notebook name': 'Smoke Notebook', 'Section name': 'Smoke Section' };
    await d.accept(answers[d.message()] ?? 'x');
  });
  const step = async (name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { console.log('FAIL', name, e.message.split('\n')[0]); await shot(page, 'fail-' + name.replace(/\W+/g, '_')); throw e; } };
  try {
    const email = `smoke${Date.now()}@example.com`;
    await step('open', () => page.goto(BASE + '/login'));
    await step('sign up', async () => {
      await page.getByRole('button', { name: 'Create an account' }).click();
      await page.getByLabel('Name').fill('Smoke Tester');
      await page.getByLabel('Email').fill(email);
      await page.getByLabel('Password').fill('password123');
      await page.getByRole('button', { name: 'Create account' }).click();
      await page.waitForURL(/\/w\//);
    });
    await shot(page, '01-after-signup');
    await step('create notebook', async () => {
      await page.getByTitle('New notebook').click();
      await page.getByText('Smoke Notebook').first().waitFor();
    });
    await step('create section', async () => {
      const row = page.locator('.sb-row', { hasText: 'Smoke Notebook' }).first();
      await row.hover();
      await row.getByTitle('Notebook options').click();
      await page.getByRole('menuitem', { name: /section/i }).first().click().catch(async () => { await page.getByText(/New section|Add section/).first().click(); });
      await page.getByText('Smoke Section').first().waitFor();
    });
    await step('create page', async () => {
      const row = page.locator('.sb-row', { hasText: 'Smoke Section' }).first();
      await row.hover();
      await row.getByTitle('New page').click();
      await page.waitForURL(/\/p\//);
      await page.locator('.ProseMirror').waitFor();
    });
    await shot(page, '02-new-page');
    await step('type in page', async () => {
      await page.locator('.ProseMirror').click();
      await page.keyboard.type('Hello from the smoke test');
      await page.keyboard.press('Enter');
      await page.getByText('Hello from the smoke test').waitFor();
    });
    const title = 'Smoke inline task';
    await step('add inline task', async () => {
      await page.keyboard.type('[] ');
      const input = page.locator('.task-ref-title').last();
      await input.waitFor();
      await input.fill(title + ' today');
      await input.press('Enter'); // commits + makes a new task
      await page.waitForTimeout(300);
      await page.keyboard.press('Enter'); // empty task + Enter → leave task mode
      await page.waitForTimeout(1500); // let collab save
    });
    await shot(page, '03-task-in-note');
    const pageUrl = page.url();
    await step('task on Today', async () => {
      await page.goto(pageUrl.replace(/\/p\/.*/, '/tasks/today'));
      await page.getByText(title).first().waitFor({ timeout: 5000 });
    });
    await shot(page, '04-today');
    await step('complete on Today', async () => {
      const row = page.locator('.task-row', { hasText: title }).first();
      await row.locator('.task-checkbox, [role=checkbox], button[aria-label*="omplete"]').first().click();
      await page.waitForTimeout(2000);
    });
    await shot(page, '05-today-after');
    await step('done in note', async () => {
      await page.goto(pageUrl);
      await page.locator('.task-ref .task-ref-title').first().waitFor();
      await page.waitForFunction((t) => [...document.querySelectorAll('.task-ref')].some((el) => el.querySelector('.task-ref-title')?.value === t && el.classList.contains('is-done')), title, { timeout: 5000 }).catch(() => {});
      const cls = await page.evaluate((t) => [...document.querySelectorAll('.task-ref')].find((el) => el.querySelector('.task-ref-title')?.value === t)?.className ?? 'missing', title);
      if (!cls.includes('is-done')) throw new Error('task-ref not done: ' + cls);
    });
    await shot(page, '06-note-after');
    await step('note text persisted', async () => {
      await page.reload();
      await page.getByText('Hello from the smoke test').waitFor();
    });
  } catch (e) {
    process.exitCode = 1;
  } finally {
    console.log('--- console errors/warnings ---\n' + errors.join('\n'));
    await browser.close();
  }
})();
