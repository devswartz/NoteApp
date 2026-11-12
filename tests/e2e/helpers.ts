// Shared helpers for the E2E suite (owner: QA).
// Setup that isn't under test goes through the REST API (fast, not flaky); the behaviour under test goes through the UI.
import { expect, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

export const PASSWORD = 'e2e-password-123';
const REFRESH_KEY = 'noteapp.refreshToken';

export interface TestUser {
  id: string;
  name: string;
  email: string;
  token: string;
  refreshToken: string;
  /** The user's personal workspace. */
  wsId: string;
}

export function uniqueEmail(prefix = 'user') {
  return `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}@e2e.test`.toLowerCase();
}

/** Thin JSON client for /api with a bearer token. Throws on non-2xx with the server's message. */
export async function api<T = unknown>(request: APIRequestContext, method: string, path: string, token?: string, body?: unknown): Promise<T> {
  const send = () =>
    request.fetch(`/api${path}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
      data: body === undefined ? undefined : JSON.stringify(body),
    });
  let res;
  try {
    res = await send();
  } catch (e) {
    // A reused keep-alive connection can be closed by the server just as we send ("socket hang up").
    // Safe to retry reads once; writes are not retried.
    if (method !== 'GET' || !/socket hang up|ECONNRESET/.test(String(e))) throw e;
    res = await send();
  }
  const text = await res.text();
  if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()} ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Registers a user through the API (pending invites for the email are applied by the server). */
export async function createUser(request: APIRequestContext, name = 'Test User', email = uniqueEmail(name.split(' ')[0])): Promise<TestUser> {
  const s = await api<{ accessToken: string; refreshToken: string; user: { id: string; email: string; name: string } }>(
    request, 'POST', '/auth/register', undefined, { name, email, password: PASSWORD },
  );
  const workspaces = await api<{ id: string; name: string }[]>(request, 'GET', '/workspaces', s.accessToken);
  return { id: s.user.id, name, email, token: s.accessToken, refreshToken: s.refreshToken, wsId: workspaces[0]!.id };
}

/**
 * Signs the browser context in as `user` by seeding the refresh token, the way the app restores a session.
 * Only seeds an empty slot: the app rotates the token on startup, and replaying a retired one would revoke the sign-in.
 */
export async function signInContext(context: BrowserContext, user: TestUser) {
  await context.addInitScript(
    ([key, token]) => {
      try {
        if (!localStorage.getItem(key)) localStorage.setItem(key, token);
      } catch {
        /* storage unavailable */
      }
    },
    [REFRESH_KEY, user.refreshToken] as const,
  );
}

export interface Tree {
  notebookId: string;
  sectionId: string;
  pageId: string;
}

/** Creates notebook → (default "General") section → page through the API. */
export async function createPage(
  request: APIRequestContext,
  user: TestUser,
  opts: { wsId?: string; notebook?: string; page?: string; visibility?: 'shared' | 'private' } = {},
): Promise<Tree> {
  const wsId = opts.wsId ?? user.wsId;
  const nb = await api<{ id: string; sectionId: string }>(request, 'POST', `/workspaces/${wsId}/notebooks`, user.token, {
    name: opts.notebook ?? 'E2E Notebook',
    visibility: opts.visibility ?? 'shared',
  });
  const pg = await api<{ id: string }>(request, 'POST', `/sections/${nb.sectionId}/pages`, user.token, { title: opts.page ?? 'E2E Page' });
  return { notebookId: nb.id, sectionId: nb.sectionId, pageId: pg.id };
}

export async function createTask(request: APIRequestContext, user: TestUser, wsId: string, fields: Record<string, unknown>) {
  return api<{ id: string; title: string; status: string }>(request, 'POST', `/workspaces/${wsId}/tasks`, user.token, {
    assigneeId: user.id,
    ...fields,
  });
}

export async function listTasks(request: APIRequestContext, user: TestUser, wsId = user.wsId) {
  return api<{ id: string; title: string; status: string; pageId: string | null; assigneeId: string | null; dueDate: string | null }[]>(
    request, 'GET', `/workspaces/${wsId}/tasks`, user.token,
  );
}

/** A team workspace owned by `owner` with `member` added directly (member must already have an account). */
export async function createTeam(request: APIRequestContext, owner: TestUser, members: { user: TestUser; role: 'admin' | 'member' | 'viewer' }[], name = 'E2E Team') {
  const { id } = await api<{ id: string }>(request, 'POST', '/workspaces', owner.token, { name });
  for (const m of members) await api(request, 'POST', `/workspaces/${id}/members`, owner.token, { email: m.user.email, role: m.role });
  return id;
}

export const pageUrl = (wsId: string, pageId: string) => `/w/${wsId}/p/${pageId}`;
export const tasksUrl = (wsId: string, view: string) => `/w/${wsId}/tasks/${view}`;

/**
 * The editor of a page's first text box. Every page is a canvas; a blank one offers its first
 * box ready for typing (stored once something is typed), and a converted document is one box.
 */
export const firstEditor = (page: Page) => page.locator('.canvas-box .ProseMirror').first();

/** Opens a page and waits until the editor (its first text box) is connected and editable. */
export async function openPage(page: Page, wsId: string, pageId: string) {
  await page.goto(pageUrl(wsId, pageId));
  const editor = firstEditor(page);
  await expect(editor).toBeVisible();
  await expect(page.locator('.sync-live')).toBeVisible({ timeout: 15_000 });
  return editor;
}

/**
 * Lets the editor take in a caret move. The browser reports a selection change a frame after it happens,
 * and ProseMirror only learns of it then: a key pressed in that gap acts on the old selection (Enter after
 * a click and Ctrl+End deleted the text that had been selected before). Two animation frames cover it.
 */
export async function settleCaret(page: Page) {
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}

/** Puts the caret at the end of the first text box. */
export async function focusEnd(page: Page) {
  const editor = firstEditor(page);
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await settleCaret(page);
  return editor;
}

/** Inserts a task with /task at the end of the note, titles and commits it, and leaves task mode. Returns the task-ref locator. */
export async function addInlineTask(page: Page, title: string) {
  await focusEnd(page);
  await page.keyboard.press('Enter');
  await page.keyboard.type('/task');
  await expect(page.locator('.slash-menu .slash-title').first()).toHaveText('Task');
  await page.keyboard.press('Enter');
  const input = page.locator('.task-ref-title:focus');
  await expect(input).toBeVisible();
  await input.fill(title);
  await input.press('Enter'); // commit + new empty task
  await expect(page.locator('.task-ref-title:focus')).toHaveValue('');
  await page.keyboard.press('Enter'); // empty task + Enter = leave task mode
  return page.locator('.task-ref', { has: page.locator(`.task-ref-title[data-value="${title.replace(/"/g, '\\"')}"]`) });
}

/** A task-ref node in the note by (exact) title. */
export function taskRef(page: Page, title: string) {
  return page.locator('.task-ref').filter({ has: page.locator('.task-ref-title').and(page.locator(`[data-value="${title.replace(/"/g, '\\"')}"]`)) });
}

/** A dashboard row by title. */
export function taskRow(page: Page, title: string) {
  return page.locator('.task-row').filter({ has: page.locator('.task-title', { hasText: title }) });
}

/** The ribbon (desktop and tablet; phones have none). */
export const ribbon = (page: Page) => page.getByRole('toolbar', { name: 'Ribbon' });

/** Filter kinds with their own ribbon button on Tasks; the rest are under "More filters". */
const RIBBON_FILTERS = ['Assignee', 'Tags', 'Team', 'Priority'];

/**
 * All Tasks: filter by kind → value. Desktop: the ribbon's Filter group (the kind's button, or More
 * filters → kind). Phones: the filter bar's Add filter → kind.
 */
export async function addFilter(page: Page, kind: string, value: string) {
  const bar = ribbon(page);
  if (await bar.isVisible()) {
    if (RIBBON_FILTERS.includes(kind)) await bar.getByRole('button', { name: new RegExp(`^${kind} filter`) }).click();
    else {
      await bar.getByRole('button', { name: 'More filters' }).click();
      await page.getByRole('menuitem', { name: kind, exact: true }).click();
    }
  } else {
    await page.getByRole('button', { name: 'Add filter' }).click();
    await page.getByRole('menuitem', { name: kind, exact: true }).click();
  }
  const esc = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match the item's label exactly (people items also contain their avatar's initials).
  await page.locator('.popover [role="menuitem"], .popover [role="menuitemcheckbox"]').filter({ has: page.locator('.menu-label', { hasText: new RegExp(`^${esc}$`) }) }).first().click(); // (a person in two teams is listed under both)
  await page.keyboard.press('Escape'); // most kinds take several values and stay open
}

/** Desktop: remove one filter from its ribbon menu. */
export async function removeFilter(page: Page, kind: string) {
  const bar = ribbon(page);
  if (RIBBON_FILTERS.includes(kind)) await bar.getByRole('button', { name: new RegExp(`^${kind} filter`) }).click();
  else throw new Error(`removeFilter: ${kind} has no ribbon button`);
  await page.getByRole('menuitem', { name: `Remove ${kind} filter` }).click();
}

/** Polls the API until `check` passes (for server-side effects such as the debounced page save). */
export async function eventually<T>(fn: () => Promise<T>, check: (v: T) => boolean, message: string, timeout = 10_000) {
  await expect.poll(async () => check(await fn()), { message, timeout }).toBe(true);
}

/** Switches the desktop rail to a view (Notes, Tasks or Calendar). */
export async function railTo(page: Page, view: 'Notes' | 'Tasks' | 'Calendar') {
  await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: view, exact: true }).click();
}

/** Opens the Notes panel's notebook picker (my notebooks, then "Shared with me") and returns its menu. */
export async function openNotebookPicker(page: Page) {
  await page.locator('.nb-picker-btn').click();
  const menu = page.locator('.nb-menu');
  await expect(menu).toBeVisible();
  return menu;
}

/** YYYY-MM-DD in UTC (the suite runs the browser in UTC). */
export function isoDay(offsetDays = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}
