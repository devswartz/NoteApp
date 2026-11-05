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

/** Opens a page and waits until the editor is connected and editable. */
export async function openPage(page: Page, wsId: string, pageId: string) {
  await page.goto(pageUrl(wsId, pageId));
  const editor = page.locator('.ProseMirror');
  await expect(editor).toBeVisible();
  await expect(page.locator('.sync-live')).toBeVisible({ timeout: 15_000 });
  return editor;
}

/** Puts the caret at the end of the document. */
export async function focusEnd(page: Page) {
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  return editor;
}

/** Types "[] title" at the end of the note, commits it and leaves task mode. Returns the task-ref locator. */
export async function addInlineTask(page: Page, title: string) {
  await focusEnd(page);
  await page.keyboard.press('Enter');
  await page.keyboard.type('[] ');
  const input = page.locator('.task-ref-title:focus');
  await expect(input).toBeVisible();
  await input.fill(title);
  await input.press('Enter'); // commit + new empty task
  await expect(page.locator('.task-ref-title:focus')).toHaveValue('');
  await page.keyboard.press('Enter'); // empty task + Enter = leave task mode
  return page.locator('.task-ref', { has: page.locator(`.task-ref-title[value="${title.replace(/"/g, '\\"')}"]`) });
}

/** A task-ref node in the note by (exact) title. */
export function taskRef(page: Page, title: string) {
  return page.locator('.task-ref').filter({ has: page.locator('.task-ref-title').and(page.locator(`[value="${title.replace(/"/g, '\\"')}"]`)) });
}

/** A dashboard row by title. */
export function taskRow(page: Page, title: string) {
  return page.locator('.task-row').filter({ has: page.locator('.task-title', { hasText: title }) });
}

/** Polls the API until `check` passes (for server-side effects such as the debounced page save). */
export async function eventually<T>(fn: () => Promise<T>, check: (v: T) => boolean, message: string, timeout = 10_000) {
  await expect.poll(async () => check(await fn()), { message, timeout }).toBe(true);
}

/** YYYY-MM-DD in UTC (the suite runs the browser in UTC). */
export function isoDay(offsetDays = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}
