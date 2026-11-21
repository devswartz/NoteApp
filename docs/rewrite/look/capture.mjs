// Reference screenshots of today's web app for the native look (docs/rewrite/LOOK.md).
// See docs/rewrite/look/README.md: seed a scratch DATA_DIR (seed.ts), start the API and the web
// dev server, then:
//   DATA_DIR=<same dir> BASE=http://127.0.0.1:4418 node docs/rewrite/look/capture.mjs [viewport…]
// Writes docs/rewrite/look/reference/<viewport>/<state>.png and reference/index.md.
// Only ever run against a local dev server with the demo seed (local test credentials).
import { chromium, devices } from '@playwright/test';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'reference');
const BASE = process.env.BASE ?? 'http://127.0.0.1:4418';
const DATA_DIR = process.env.DATA_DIR;
if (!DATA_DIR) throw new Error('Set DATA_DIR to the seeded data directory (see README.md)');
const EMAIL = 'demo@example.com';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'demo-pass-123';

// ── Ids from the seeded database (read-only) ──
const db = new Database(path.join(DATA_DIR, 'noteapp.db'), { readonly: true, fileMustExist: true });
const one = (sql, ...a) => db.prepare(sql).get(...a);
const ws = {
  team: one("SELECT id FROM workspaces WHERE name = 'Demo Team'").id,
  empty: one("SELECT id FROM workspaces WHERE name = 'Empty Space'").id,
};
const pageId = (title) => one('SELECT p.id FROM pages p JOIN sections s ON s.id = p.section_id JOIN notebooks n ON n.id = s.notebook_id WHERE n.workspace_id = ? AND p.title LIKE ?', ws.team, title).id;
const pages = {
  canvas: pageId('Canvas'),
  sandbox: pageId('Sandbox'),
  blocks: pageId('Blocks'),
  lists: pageId('Lists'),
  tasks: pageId('Tasks'),
  ink: pageId('Settings and ink'),
  meeting: pageId('Weekly sync%'),
  roadmap: pageId('Q4 roadmap'),
};
const emptySection = one("SELECT id FROM sections WHERE name = 'Empty section'").id;
db.close();

// ── Viewports: Playwright's iPad / iPhone descriptors (touch, mobile UA), at the sizes asked for ──
const VIEWPORTS = {
  'ipad-landscape': { ...devices['iPad Pro 11 landscape'], viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1 },
  'ipad-portrait': { ...devices['iPad Pro 11'], viewport: { width: 820, height: 1180 }, deviceScaleFactor: 1 },
  iphone: { ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 },
};
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(VIEWPORTS);

const index = []; // [viewport, file, what]
const browser = await chromium.launch();

async function session(vp, theme) {
  const ctx = await browser.newContext({ ...VIEWPORTS[vp], reducedMotion: 'reduce', colorScheme: theme === 'dark' ? 'dark' : 'light', locale: 'en-GB', timezoneId: 'Europe/London' });
  await ctx.addInitScript((t) => {
    try {
      localStorage.setItem('noteapp.theme', t);
    } catch {}
  }, theme);
  const page = await ctx.newPage();
  return { ctx, page };
}

async function signIn(page) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[type=email]', EMAIL);
  await page.fill('input[type=password]', PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForURL(/\/w\//, { timeout: 20000 });
  await page.waitForTimeout(800);
}

const settle = (page, ms = 700) => page.waitForTimeout(ms);

async function go(page, url) {
  await page.goto(`${BASE}${url}`);
  await page.waitForLoadState('networkidle').catch(() => {});
  await settle(page, 900);
}

async function openPage(page, id) {
  await go(page, `/w/${ws.team}/p/${id}`);
  await page.locator('.canvas-box').first().waitFor({ timeout: 15000 }).catch(() => {});
  await page.locator('.sync.save-saved').first().waitFor({ state: 'attached', timeout: 8000 }).catch(() => {});
  // Nothing focused: the ribbon shows its idle state, no caret.
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
  await settle(page, 900);
}

function shooter(vp, page, prefix = '') {
  const dir = path.join(OUT, vp);
  fs.mkdirSync(dir, { recursive: true });
  return async (name, what, opts = {}) => {
    const file = `${prefix}${name}.png`;
    const shot = { path: path.join(dir, file), animations: 'disabled', caret: opts.caret ? 'initial' : 'hide' };
    try {
      if (opts.element) await page.locator(opts.element).first().screenshot(shot);
      else await page.screenshot({ ...shot, clip: opts.clip });
      index.push([vp, file, what]);
      console.log(`${vp}/${file}`);
    } catch (e) {
      console.log(`SKIPPED ${vp}/${file}: ${e.message.split('\n')[0]}`);
    }
  };
}

async function closeMenus(page) {
  await page.keyboard.press('Escape').catch(() => {});
  await settle(page, 300);
  await page.keyboard.press('Escape').catch(() => {});
  await settle(page, 300);
  // The phone drawer closes on a tap on its backdrop, not on Escape.
  if (await page.locator('.drawer-backdrop').count()) {
    const { width } = page.viewportSize();
    await page.mouse.click(width - 8, 300);
    await settle(page, 600);
  }
}

/** Clip from the top of the window to `extra` px below the ribbon (ribbon dropdowns). */
async function ribbonClip(page, extra) {
  const box = await page.locator('.ribbon').first().boundingBox();
  const vw = page.viewportSize().width;
  return { x: 0, y: 0, width: vw, height: Math.min(page.viewportSize().height, Math.round((box?.y ?? 0) + (box?.height ?? 70) + extra)) };
}

/** Focus the paragraph containing `text` in a box, caret at its end. */
async function caretAtEnd(page, text) {
  const p = page.locator('.canvas-box .ProseMirror :is(p,h1,h2,h3)', { hasText: text }).first();
  await p.click();
  await page.keyboard.press('End');
  await settle(page, 500);
}

async function scrollPage(page, by) {
  await page.evaluate((y) => {
    const s = document.querySelector('.page-scroll') ?? document.querySelector('.main');
    if (s) s.scrollTop = y;
  }, by);
  await settle(page, 500);
}

async function scrollable(page) {
  return page.evaluate(() => {
    const s = document.querySelector('.page-scroll');
    return s ? s.scrollHeight - s.clientHeight : 0;
  });
}

// ───────── One viewport, light theme: every state ─────────
async function captureLight(vp) {
  const phone = vp === 'iphone';
  const { ctx, page } = await session(vp, 'light');
  const shot = shooter(vp, page);

  await page.goto(`${BASE}/login`);
  await settle(page, 1200);
  await shot('sign-in', 'Sign-in screen (Login.tsx)');
  await signIn(page);

  // Pages, one per corpus case and two demo pages. iPad: the sidebar (notes tree) is open beside them.
  const PAGES = [
    ['page-canvas-boxes', pages.canvas, 'Corpus canvas-boxes: boxes placed on the canvas (phones: stacked)'],
    ['page-blocks', pages.blocks, 'Corpus blocks: callout, toggle, table, image, file card, mentions, page link'],
    ['page-lists', pages.lists, 'Corpus lists: bullets, numbered (letters, roman, ")"), checklists'],
    ['page-tasks', pages.tasks, 'Corpus tasks: task lines with notes, checklist, subtask, done task'],
    ['page-settings-and-ink', pages.ink, 'Corpus settings-and-ink: blue page colour, grid rule lines, ink'],
    ['page-meeting', pages.meeting, 'Demo "Weekly sync": tasks with priority, due, assignee, recurrence'],
    ['page-roadmap', pages.roadmap, 'Demo "Q4 roadmap": callout, headings, table, toggle'],
  ];
  for (const [name, id, what] of PAGES) {
    await openPage(page, id);
    await shot(name, what);
    const more = await scrollable(page);
    const vh = page.viewportSize().height;
    if (more > vh * 0.4) {
      await scrollPage(page, Math.round(vh * 0.8));
      await shot(`${name}-2`, `${what} (scrolled down)`);
    }
  }

  // Sidebar: iPad shows it beside the page (above); phones open the drawer.
  if (phone) {
    await go(page, `/w/${ws.team}/notes`);
    await shot('notes-home', 'Phone Notes screen: notebooks list (NotesHome NotebooksScreen)');
    await page.click('button[aria-label="Open menu"]');
    await settle(page, 800);
    await shot('sidebar-drawer', 'Phone drawer: workspace switcher, notebook picker, section tree, user row');
    await closeMenus(page);
  } else {
    await openPage(page, pages.canvas);
    const opened = await ensureSidebar(page);
    if (opened) await shot('page-canvas-boxes-sidebar-open', 'Canvas page after "Show sidebar" (the sidebar starts closed below 900 px wide)');
    await shot('sidebar', 'Sidebar open with notebook picker, sections and pages (tree expanded)', { clip: await sidebarClip(page) });
    if (opened) {
      // Back to this width's default (closed), which the editing shots below expect.
      await page.click('.rail button[aria-label="Hide sidebar"]');
      await settle(page);
    }
  }

  // Editing: caret, selection (floating toolbar), slash menu, in the Sandbox page.
  await openPage(page, pages.sandbox);
  await caretAtEnd(page, 'Box c');
  await shot('edit-caret', 'A box being edited: caret at the end of "Box c", box chrome (border, move bar, width handle)', { caret: true });
  if (!phone) await shot('ribbon-page-active', 'Note ribbon while editing (controls enabled)', { element: '.ribbon' });
  await page.keyboard.press('Shift+Home');
  await settle(page, 800);
  await shot('edit-selection', 'Text selected ("Box c"): selection colour and the floating formatting toolbar', { caret: true });
  await caretAtEnd(page, 'Box c');
  await page.keyboard.press('Enter');
  await page.mouse.move(2, page.viewportSize().height - 2); // not over the menu: no hover highlight
  await page.keyboard.type('/');
  await settle(page, 800);
  await shot('slash-menu', 'Slash menu ("/" on an empty line)', { caret: true });
  // Undo the typing: deleting the "/" closes the menu, the second Backspace removes the new line.
  await page.keyboard.press('Backspace');
  await settle(page, 300);
  await page.keyboard.press('Backspace');
  await settle(page, 600);

  // Ribbon (tablets only; phones have none): each section's ribbon and the note ribbon's menus.
  if (!phone) {
    await openPage(page, pages.sandbox);
    await shot('ribbon-page-idle', 'Note ribbon with no box focused (editing controls disabled)', { element: '.ribbon' });
    await caretAtEnd(page, 'Box c');
    const menus = [
      ['ribbon-menu-block', '.ribbon .tb-block', 'Ribbon: block type menu'],
      ['ribbon-menu-text-colour', '.ribbon button[aria-label="Text colour"]', 'Ribbon: text colour menu'],
      ['ribbon-menu-highlight', '.ribbon button[aria-label="Highlight"]', 'Ribbon: highlight menu'],
      ['ribbon-menu-task', '.ribbon button[aria-label="More list options"]', 'Ribbon: Task split button menu'],
      ['ribbon-menu-page-colour', '.ribbon button[aria-label="Page colour"]', 'Ribbon: page colour menu'],
      ['ribbon-menu-rule-lines', '.ribbon button[aria-label="Rule lines"]', 'Ribbon: rule lines menu'],
    ];
    for (const [name, sel, what] of menus) {
      await caretAtEnd(page, 'Box c');
      await page.click(sel);
      await settle(page, 600);
      await shot(name, what, { clip: await ribbonClip(page, 330) });
      await closeMenus(page);
    }
    await page.click('.ribbon button[aria-label="Collapse the ribbon"]');
    await settle(page);
    await shot('ribbon-collapsed', 'Ribbon collapsed to its strip', { element: '.ribbon' });
    await page.click('.ribbon button[aria-label="Show the ribbon"]');
    await settle(page);

    await go(page, `/w/${ws.team}/tasks/today`);
    await shot('ribbon-tasks', 'Tasks ribbon', { element: '.ribbon' });
    await go(page, `/w/${ws.team}/tasks/calendar`);
    await shot('ribbon-calendar', 'Calendar ribbon', { element: '.ribbon' });
    await go(page, `/w/${ws.team}/notes`);
    await shot('ribbon-notes', 'Notes overview ribbon', { element: '.ribbon' });
    await go(page, `/w/${ws.team}/settings`);
    await shot('ribbon-settings', 'Settings ribbon', { element: '.ribbon' });
    await shot('settings', 'Settings screen (personal)');
  }

  // Tasks views.
  for (const [view, what] of [
    ['today', 'Tasks: Today'],
    ['upcoming', 'Tasks: Upcoming'],
    ['my', 'Tasks: My Tasks'],
    ['all', 'Tasks: All tasks'],
    ['calendar', 'Tasks: Calendar'],
  ]) {
    await go(page, `/w/${ws.team}/tasks/${view}`);
    await shot(`tasks-${view}`, what);
  }
  await go(page, `/w/${ws.team}/tasks/my`);
  await page.locator('.task-row .task-title-btn').first().click().catch(() => {});
  await settle(page, 900);
  await shot('task-detail', 'Task detail sheet (click a task)');
  await closeMenus(page);

  // Page side panel (tasks on this page).
  await openPage(page, pages.meeting);
  await page.click('.page-topbar button[title="Tasks on this page"]');
  await settle(page, 900);
  await shot('page-tasks-panel', 'Page with its "Tasks on this page" panel open');
  await page.click('button[aria-label="Close panel"]').catch(() => {});
  await settle(page);

  // Menus.
  await openPage(page, pages.canvas);
  await page.click('.page-topbar button[title="Page options"]');
  await settle(page);
  await shot('menu-page-options', 'Page "⋯" menu (top bar)');
  await closeMenus(page);
  if (phone) {
    await openDrawer(page);
    await page.locator('.sidebar .sec-row').first().click({ button: 'right' });
    await settle(page);
    await shot('menu-section', 'Section menu (right-click / long-press a section)');
    await closeMenus(page);
    await openDrawer(page);
    await page.locator('.sidebar .page-row').first().click({ button: 'right' });
    await settle(page);
    await shot('menu-page-row', 'Page row menu (right-click / long-press a page in the tree)');
    await closeMenus(page);
    await openDrawer(page);
    await page.click('.sidebar button[aria-label="Notebook options"]');
    await settle(page);
    await shot('menu-notebook', 'Notebook options menu');
    await closeMenus(page);
    await openDrawer(page);
    await page.click('.sidebar button[title="Switch notebook"]');
    await settle(page);
    await shot('menu-notebook-picker', 'Notebook picker');
    await closeMenus(page);
    await openDrawer(page);
    await page.click('.sidebar button[title="Switch workspace"]');
    await settle(page);
    await shot('menu-workspace', 'Workspace switcher');
    await closeMenus(page);
    await openDrawer(page);
    await page.click('.sidebar button[title="Account and settings"]');
    await settle(page);
    await shot('menu-account', 'Account and settings menu (theme toggle)');
    await closeMenus(page);
  } else {
    await ensureSidebar(page);
    await page.locator('.sidebar .sec-row').first().click({ button: 'right' });
    await settle(page);
    await shot('menu-section', 'Section menu (right-click / long-press a section)');
    await closeMenus(page);
    await page.locator('.sidebar .page-row.is-active').first().click({ button: 'right' });
    await settle(page);
    await shot('menu-page-row', 'Page row menu (right-click / long-press a page in the tree)');
    await closeMenus(page);
    await page.click('.sidebar button[aria-label="Notebook options"]');
    await settle(page);
    await shot('menu-notebook', 'Notebook options menu');
    await closeMenus(page);
    await page.click('.sidebar button[title="Switch notebook"]');
    await settle(page);
    await shot('menu-notebook-picker', 'Notebook picker');
    await closeMenus(page);
    await page.click('.rail button[title="Switch workspace"]');
    await settle(page);
    await shot('menu-workspace', 'Workspace switcher (rail)');
    await closeMenus(page);
    await page.click('.rail button[title="Account and settings"]');
    await settle(page);
    await shot('menu-account', 'Account and settings menu (rail; theme toggle)');
    await closeMenus(page);
    await page.locator('.canvas-box-move').first().click({ button: 'right', force: true });
    await settle(page);
    await shot('menu-text-box', 'Text box menu (right-click a box\'s top bar)');
    await closeMenus(page);
  }

  // Search and quick add.
  if (phone) await page.click('.mobile-top button[aria-label="Search"]');
  else await page.click('.rail button[aria-label="Search"]');
  await settle(page, 800);
  await page.keyboard.type('plan');
  await settle(page, 1000);
  await shot('search', 'Search / command palette with results for "plan"');
  await closeMenus(page);
  await go(page, `/w/${ws.team}/tasks/today`);
  if (phone) await page.click('.fab');
  else await page.click('.ribbon button[aria-label="New task"]');
  await settle(page, 800);
  await shot('quick-add', 'Quick add task dialog');
  await closeMenus(page);

  // Empty states.
  if (!phone) {
    await go(page, `/w/${ws.team}/notes`);
    await shot('empty-no-page', 'No page selected: the Notes overview (recently edited, all notebooks)');
  }
  await go(page, `/w/${ws.team}/notes?sec=${emptySection}`);
  await shot('empty-section', 'An empty section');
  await go(page, `/w/${ws.empty}/notes`);
  await shot('empty-workspace-notes', 'A workspace with no notebooks');
  if (phone) {
    await openDrawer(page);
    await shot('empty-workspace-drawer', 'Drawer of a workspace with no notebooks');
    await closeMenus(page);
  }
  await go(page, `/w/${ws.empty}/tasks/today`);
  await shot('empty-tasks-today', 'Tasks: Today with nothing due');
  await go(page, `/w/${ws.empty}/tasks/all`);
  await shot('empty-tasks-all', 'Tasks: All tasks with no tasks');

  await ctx.close();
}

async function openDrawer(page) {
  if (await page.locator('.sidebar-open').count()) return;
  const back = page.locator('.mobile-top button[aria-label="Back"]');
  if (await back.count()) {
    await back.click();
    await settle(page);
  }
  await page.click('.mobile-top button[aria-label="Open menu"]');
  await settle(page, 800);
}

/** Tablets: open the sidebar if it is closed (it starts closed below 900 px). True if it was closed. */
async function ensureSidebar(page) {
  if (!(await page.locator('.app.sidebar-closed').count())) return false;
  await page.click('.rail button[aria-label="Show sidebar"]');
  await settle(page, 800);
  return true;
}

async function sidebarClip(page) {
  const sb = await page.locator('.sidebar').first().boundingBox();
  const vp = page.viewportSize();
  if (!sb) return undefined;
  return { x: 0, y: 0, width: Math.min(vp.width, Math.round(sb.x + sb.width + 1)), height: vp.height };
}

// ───────── Dark and Hybrid (the default theme): the main screens ─────────
async function captureThemes(vp) {
  const phone = vp === 'iphone';
  for (const theme of ['dark', 'hybrid']) {
    const { ctx, page } = await session(vp, theme);
    const shot = shooter(vp, page, `${theme}-`);
    await page.goto(`${BASE}/login`);
    await settle(page, 1200);
    await shot('sign-in', `Sign-in (${theme})`);
    await signIn(page);
    await openPage(page, pages.canvas);
    await shot('page-canvas-boxes', `Canvas page with sidebar (${theme})`);
    await openPage(page, pages.meeting);
    await shot('page-meeting', `Meeting page with tasks (${theme})`);
    await openPage(page, pages.ink);
    await shot('page-settings-and-ink', `Blue page colour + grid (${theme})`);
    await openPage(page, pages.sandbox);
    await caretAtEnd(page, 'Box c');
    await shot('edit-caret', `Editing a box (${theme})`, { caret: true });
    if (phone) {
      await openDrawer(page);
      await shot('sidebar-drawer', `Drawer (${theme})`);
      await closeMenus(page);
    } else {
      await page.click('.rail button[title="Account and settings"]');
      await settle(page);
      await shot('menu-account', `Account menu (${theme})`);
      await closeMenus(page);
    }
    await go(page, `/w/${ws.team}/tasks/today`);
    await shot('tasks-today', `Tasks: Today (${theme})`);
    await ctx.close();
  }
}

for (const vp of wanted) {
  if (!VIEWPORTS[vp]) throw new Error(`Unknown viewport ${vp}`);
  fs.rmSync(path.join(OUT, vp), { recursive: true, force: true });
  await captureLight(vp);
  if (vp !== 'ipad-portrait') await captureThemes(vp);
}
await browser.close();

// ── index.md (merged with entries of viewports not captured this run) ──
const idxFile = path.join(OUT, 'index.json');
const prev = fs.existsSync(idxFile) ? JSON.parse(fs.readFileSync(idxFile, 'utf8')) : [];
const all = [...prev.filter(([v]) => !wanted.includes(v)), ...index];
fs.writeFileSync(idxFile, JSON.stringify(all, null, 1) + '\n');
const order = Object.keys(VIEWPORTS);
let md = '# Reference screenshots\n\nToday\'s web app, captured by `docs/rewrite/look/capture.mjs` (see `../README.md`). Light theme unless the file starts with `dark-` or `hybrid-` (Hybrid is the web app\'s default theme: dark chrome, light page). Described in `docs/rewrite/LOOK.md`.\n\n';
for (const vp of order) {
  const rows = all.filter(([v]) => v === vp);
  if (!rows.length) continue;
  const size = VIEWPORTS[vp];
  md += `## ${vp} (${size.viewport.width}×${size.viewport.height} CSS px @${size.deviceScaleFactor}x)\n\n| File | What |\n|---|---|\n`;
  for (const [, file, what] of rows) md += `| [\`${vp}/${file}\`](${vp}/${file}) | ${what.replace(/\|/g, '\\|')} |\n`;
  md += '\n';
}
fs.writeFileSync(path.join(OUT, 'index.md'), md);
console.log(`${index.length} screenshots`);
