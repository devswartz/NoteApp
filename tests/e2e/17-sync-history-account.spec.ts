// Live-event catch-up after a dropped connection (#18), page version history (#37),
// page templates (#27) and changing your password (#61).
import { expect, test, type APIRequestContext, type Page, type WebSocketRoute } from '@playwright/test';
import { PASSWORD, api, createPage, createTask, createTeam, createUser, eventually, focusEnd, isoDay, openPage, signInContext, taskRow, tasksUrl, type TestUser } from './helpers.ts';

/**
 * Waits until the page's live-events socket is really delivering: creates marker tasks for `to` until one shows up.
 * (So assertions on live delivery don't race the socket's first connect.)
 */
async function waitForLiveEvents(page: Page, request: APIRequestContext, by: TestUser, wsId: string, to: TestUser) {
  let n = 0;
  await expect(async () => {
    await createTask(request, by, wsId, { title: `Live marker ${++n}`, assigneeId: to.id, dueDate: isoDay(0) });
    await expect(page.locator('.task-row', { hasText: 'Live marker' }).first()).toBeVisible({ timeout: 1_500 });
  }).toPass({ timeout: 30_000 });
}

test('events missed while disconnected are caught up on reconnect, without a reload', async ({ browser, request }) => {
  const alice = await createUser(request, 'Alice Sender');
  const bob = await createUser(request, 'Bob Dropped');
  const teamId = await createTeam(request, alice, [{ user: bob, role: 'member' }]);

  const ctx = await browser.newContext();
  await signInContext(ctx, bob);
  const page = await ctx.newPage();
  // Proxy the live-events socket so we can drop it and refuse reconnects while "offline".
  let offline = false;
  const sockets = new Set<WebSocketRoute>();
  await page.routeWebSocket(/\/api\/events/, (ws) => {
    if (offline) return void ws.close({ code: 4000, reason: 'e2e offline' });
    ws.connectToServer();
    sockets.add(ws);
  });
  await page.goto(tasksUrl(teamId, 'my'));
  await expect(page.getByRole('heading', { name: 'My Tasks', level: 1 })).toBeVisible();
  await waitForLiveEvents(page, request, alice, teamId, bob);

  // Live while connected.
  await createTask(request, alice, teamId, { title: 'Arrives live', assigneeId: bob.id, dueDate: isoDay(0) });
  await expect(taskRow(page, 'Arrives live')).toBeVisible();

  // Drop the socket; changes made meanwhile must not be lost.
  offline = true;
  await ctx.setOffline(true);
  for (const ws of sockets) await ws.close({ code: 4000, reason: 'e2e offline' });
  sockets.clear();
  await expect(page.locator('.offline-banner')).toBeVisible();
  const missed = await createTask(request, alice, teamId, { title: 'Sent while Bob was away', assigneeId: bob.id, dueDate: isoDay(0) });
  await api(request, 'PATCH', `/tasks/${missed.id}`, alice.token, { title: 'Sent while Bob was away (edited)' });
  const live = (await api<{ id: string; title: string }[]>(request, 'GET', `/workspaces/${teamId}/tasks`, alice.token)).find((t) => t.title === 'Arrives live')!;
  await api(request, 'PATCH', `/tasks/${live.id}`, alice.token, { status: 'done' });
  await expect(taskRow(page, 'Sent while Bob was away')).toHaveCount(0);

  offline = false;
  await ctx.setOffline(false);
  await expect(page.locator('.offline-banner')).toHaveCount(0);
  await expect(taskRow(page, 'Sent while Bob was away (edited)')).toBeVisible({ timeout: 20_000 });
  await expect(taskRow(page, 'Arrives live')).toHaveCount(0);
  await ctx.close();
});

test('a change made while the app is still connecting its live events is not lost', async ({ browser, request }) => {
  const alice = await createUser(request, 'Alice Early');
  const bob = await createUser(request, 'Bob Startup');
  const teamId = await createTeam(request, alice, [{ user: bob, role: 'member' }]);
  const ctx = await browser.newContext();
  await signInContext(ctx, bob);
  const page = await ctx.newPage();
  // Hold the events socket until the dashboard has loaded, so the gap is deterministic.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.routeWebSocket(/\/api\/events/, async (ws) => {
    await gate;
    ws.connectToServer();
  });
  await page.goto(tasksUrl(teamId, 'my'));
  await expect(page.getByRole('heading', { name: 'My Tasks', level: 1 })).toBeVisible();
  await createTask(request, alice, teamId, { title: 'Made during startup', assigneeId: bob.id, dueDate: isoDay(0) });
  release();
  await waitForLiveEvents(page, request, alice, teamId, bob);
  await expect(taskRow(page, 'Made during startup')).toBeVisible();
  await ctx.close();
});

test('version history: restore an earlier version of a page', async ({ page, context, request }) => {
  const user = await createUser(request, 'Vera Versions');
  const { pageId } = await createPage(request, user, { page: 'Evolving doc' });
  await signInContext(context, user);
  const editor = await openPage(page, user.wsId, pageId);
  await focusEnd(page);
  await page.keyboard.type('First draft wording');
  // Wait for the page to be saved, then snapshot it (the automatic sweep runs every few minutes).
  await eventually(() => api<{ text?: string; page?: { text?: string } }>(request, 'GET', `/workspaces/${user.wsId}/search?q=wording`, user.token), (r) => JSON.stringify(r).includes(pageId), 'first draft saved');
  await api(request, 'POST', `/pages/${pageId}/versions`, user.token, { reason: 'manual' });

  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Completely rewritten text');
  await expect(editor).not.toContainText('First draft wording');

  await page.getByRole('button', { name: 'Page options', exact: true }).click();
  await page.getByRole('menuitem', { name: /history/i }).click();
  const history = page.getByRole('dialog', { name: 'Version history' });
  await expect(history.locator('.history-item').first()).toBeVisible();
  // Oldest entry = the manual snapshot of the first draft.
  await history.locator('.history-item').last().click();
  await expect(history.locator('.history-doc')).toContainText('First draft wording');
  page.once('dialog', (d) => void d.accept());
  await history.getByRole('button', { name: 'Restore this version' }).click();
  await expect(history).toHaveCount(0);
  await expect(editor).toContainText('First draft wording');
  await expect(editor).not.toContainText('Completely rewritten text');

  await page.reload();
  await expect(page.locator('.ProseMirror')).toContainText('First draft wording');
});

test('an empty page offers templates; "Meeting notes" fills in the structure and title', async ({ page, context, request }) => {
  const user = await createUser(request, 'Tom Template');
  const { pageId } = await createPage(request, user, { page: '' });
  await signInContext(context, user);
  const editor = await openPage(page, user.wsId, pageId);
  const picker = page.getByLabel('Start with a template');
  await expect(picker).toBeVisible();
  await picker.getByRole('button', { name: /Meeting notes/ }).click();
  await expect(editor.locator('h2', { hasText: 'Attendees' })).toBeVisible();
  await expect(editor.locator('h2', { hasText: 'Action items' })).toBeVisible();
  await expect(page.locator('.page-title')).toHaveValue(/^Meeting · /);
  await expect(picker).toHaveCount(0);
});

test('change password: old one stops working, new one works', async ({ page, context, request }) => {
  const user = await createUser(request, 'Pia Password');
  await signInContext(context, user);
  await page.goto(`/w/${user.wsId}/settings`);
  await page.getByLabel('Current password').fill(PASSWORD);
  await page.getByLabel('New password', { exact: true }).fill('brand-new-password-42');
  await page.getByLabel('Confirm new password').fill('brand-new-password-42');
  await page.getByRole('button', { name: 'Change password' }).click();

  await eventually(
    async () => (await request.post('/api/auth/login', { data: { email: user.email, password: 'brand-new-password-42' } })).status(),
    (s) => s === 200,
    'new password accepted',
  );
  expect((await request.post('/api/auth/login', { data: { email: user.email, password: PASSWORD } })).status()).toBe(401);
  // Still signed in on this device.
  await page.reload();
  await expect(page).not.toHaveURL(/\/login/);
});
