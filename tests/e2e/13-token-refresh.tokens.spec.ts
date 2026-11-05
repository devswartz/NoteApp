// Runs against the short-token server (`short-tokens` project, ACCESS_TOKEN_TTL_S = 6 s):
// the app must keep working across several access-token expiries without signing the user out.
// Access tokens expire every few seconds here, so server checks sign in fresh each time.
import { expect, test, type APIRequestContext } from '@playwright/test';
import { PASSWORD, api, createPage, createUser, focusEnd, openPage, signInContext, taskRow, tasksUrl, type TestUser } from './helpers.ts';

test.setTimeout(60_000);

async function token(request: APIRequestContext, user: TestUser) {
  return (await api<{ accessToken: string }>(request, 'POST', '/auth/login', undefined, { email: user.email, password: PASSWORD })).accessToken;
}

/** Waits past one more access-token lifetime (the server's TTL is 6 s), without a fixed sleep in the app under test. */
async function outliveToken() {
  const start = Date.now();
  await expect.poll(() => Date.now() - start, { timeout: 10_000, intervals: [500] }).toBeGreaterThan(7_000);
}

test('editing and live updates keep working across access-token expiries', async ({ browser, request }) => {
  const user = await createUser(request, 'Tara Token');
  const { pageId } = await createPage(request, user, { page: 'Long session' });
  const ctx = await browser.newContext();
  await signInContext(ctx, user);
  const page = await ctx.newPage();
  await openPage(page, user.wsId, pageId);

  // Edit before and after two token expiries; the collab socket is closed with 4401 at expiry and must reconnect.
  await focusEnd(page);
  await page.keyboard.type('Before expiry.');
  await outliveToken();
  await focusEnd(page);
  await page.keyboard.type(' After first expiry.');
  await outliveToken();
  await focusEnd(page);
  await page.keyboard.type(' After second expiry.');
  await expect(page.locator('.sync-live')).toBeVisible({ timeout: 10_000 });

  // REST still works from the app (401 → refresh → retry): add a task with quick add.
  await page.goto(tasksUrl(user.wsId, 'today'));
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.getByRole('heading', { name: 'Today', level: 1 })).toBeVisible();
  await outliveToken();
  await page.keyboard.press('q');
  const qa = page.getByRole('dialog', { name: 'Quick add task' });
  await qa.locator('.qa-input').fill('Made with a refreshed token today');
  await qa.locator('.qa-input').press('Enter');
  await expect(taskRow(page, 'Made with a refreshed token')).toBeVisible();

  // Live events still arrive after expiry: a task created elsewhere shows up without a reload.
  await outliveToken();
  await api(request, 'POST', `/workspaces/${user.wsId}/tasks`, await token(request, user), { title: 'Pushed after expiry', dueDate: new Date().toISOString().slice(0, 10), assigneeId: user.id });
  await expect(taskRow(page, 'Pushed after expiry')).toBeVisible({ timeout: 15_000 });

  // Everything typed reached the server.
  const fresh = await browser.newContext();
  await signInContext(fresh, { ...user, refreshToken: (await api<{ refreshToken: string }>(request, 'POST', '/auth/login', undefined, { email: user.email, password: PASSWORD })).refreshToken });
  const check = await fresh.newPage();
  await openPage(check, user.wsId, pageId);
  await expect(check.locator('.ProseMirror')).toContainText('Before expiry. After first expiry. After second expiry.');
  await ctx.close();
  await fresh.close();
});

test('a reload after the access token expired restores the session from the refresh token', async ({ page, context, request }) => {
  const user = await createUser(request, 'Rex Reload');
  await signInContext(context, user);
  await page.goto(tasksUrl(user.wsId, 'my'));
  await expect(page.getByRole('heading', { name: 'My Tasks', level: 1 })).toBeVisible();
  await outliveToken();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'My Tasks', level: 1 })).toBeVisible();
  await expect(page).not.toHaveURL(/\/login/);
});
