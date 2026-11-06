// Sharing one page (#98): the owner shares a page from a private notebook with one teammate,
// who opens it from "Shared with me" and co-edits it live; revoking takes it away live.
import { expect, test, type Browser } from '@playwright/test';
import { api, createPage, createTeam, createUser, focusEnd, openPage, signInContext, tasksUrl, type TestUser } from './helpers.ts';

async function userPage(browser: Browser, user: TestUser) {
  const context = await browser.newContext();
  await signInContext(context, user);
  return { context, page: await context.newPage() };
}

test('share a private page with one teammate, co-edit it, then revoke', async ({ browser, request }) => {
  const alice = await createUser(request, 'Alice Sharer');
  const bob = await createUser(request, 'Bob Sharee');
  const teamId = await createTeam(request, alice, [{ user: bob, role: 'member' }], 'Share Team');
  const { pageId } = await createPage(request, alice, { wsId: teamId, notebook: 'Alice private', page: 'Secret plan', visibility: 'private' });

  const a = await userPage(browser, alice);
  const b = await userPage(browser, bob);

  // Before sharing, Bob sees neither the notebook nor the page.
  await b.page.goto(tasksUrl(teamId, 'today'));
  await expect(b.page.locator('.sidebar, nav').first()).toBeVisible();
  await expect(b.page.getByText('Alice private')).toHaveCount(0);
  await expect(b.page.getByTestId('shared-with-me')).toHaveCount(0);

  // Alice: Share → pick Bob → Can edit.
  await openPage(a.page, teamId, pageId);
  await a.page.getByRole('button', { name: 'Share', exact: true }).click();
  const dialog = a.page.locator('.page-share-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Name or email').fill('Bob Sharee');
  await dialog.getByLabel('Access', { exact: true }).selectOption('edit');
  await dialog.getByRole('option', { name: /Bob Sharee/ }).click();
  await expect(dialog.getByTestId('page-share-row')).toContainText('Bob Sharee');
  await expect(dialog.getByLabel('Access for Bob Sharee')).toHaveValue('edit');
  await dialog.getByRole('button', { name: 'Done' }).click();

  // Bob: it appears live under "Shared with me"; the notebook stays hidden.
  const shared = b.page.getByTestId('shared-with-me');
  await expect(shared.getByRole('link', { name: /Secret plan/ })).toBeVisible();
  await expect(b.page.getByText('Alice private')).toHaveCount(0);
  await shared.getByRole('link', { name: /Secret plan/ }).click();
  await expect(b.page.locator('.ProseMirror')).toBeVisible();
  await expect(b.page.locator('.sync-live')).toBeVisible({ timeout: 15_000 });
  await expect(b.page.locator('.crumbs')).toContainText('Shared with me');
  await expect(b.page.locator('.chip', { hasText: 'View only' })).toHaveCount(0);

  // Co-edit both ways.
  await focusEnd(b.page);
  await b.page.keyboard.type('Bob was here');
  await expect(a.page.locator('.ProseMirror')).toContainText('Bob was here');
  await focusEnd(a.page);
  await a.page.keyboard.press('Enter');
  await a.page.keyboard.type('Alice replies');
  await expect(b.page.locator('.ProseMirror')).toContainText('Alice replies');

  // Revoke: Bob's page closes and the entry disappears, live.
  await a.page.getByRole('button', { name: 'Share', exact: true }).click();
  await a.page.locator('.page-share-dialog').getByRole('button', { name: 'Stop sharing with Bob Sharee' }).click();
  await expect(a.page.locator('.page-share-dialog').getByTestId('page-share-row')).toHaveCount(0);
  await expect(b.page.getByRole('heading', { name: 'Page not found' })).toBeVisible({ timeout: 10_000 });
  await expect(b.page.getByTestId('shared-with-me')).toHaveCount(0);

  await a.context.close();
  await b.context.close();
});

test('someone outside the workspace opens the shared link: that page only, view-only, with its tasks', async ({ browser, request }) => {
  const alice = await createUser(request, 'Alice Owner');
  const olga = await createUser(request, 'Olga Outsider');
  const teamId = await createTeam(request, alice, [], 'Closed Team');
  const { pageId } = await createPage(request, alice, { wsId: teamId, notebook: 'Closed notebook', page: 'Public-ish note' });
  await api(request, 'POST', `/workspaces/${teamId}/tasks`, alice.token, { title: 'Visible task on the page', pageId });
  const r = await api<{ status: string }>(request, 'POST', `/pages/${pageId}/shares`, alice.token, { email: olga.email, canEdit: true });
  expect(r.status).toBe('shared');

  const o = await userPage(browser, olga);
  await o.page.goto(`/shared/${pageId}`);
  await expect(o.page).toHaveURL(new RegExp(`/w/${olga.wsId}/p/${pageId}`));
  await expect(o.page.locator('.ProseMirror')).toBeVisible();
  await expect(o.page.locator('.chip', { hasText: 'View only' })).toBeVisible();
  await expect(o.page.locator('.crumbs')).toContainText('Shared with me');
  await expect(o.page.getByTestId('shared-with-me').getByRole('link', { name: /Public-ish note/ })).toContainText('Closed Team');
  // The page's tasks render from the shared page, though Olga isn't in that workspace.
  const tasksToggle = o.page.locator('button.panel-toggle[title="Tasks on this page"]');
  await expect(tasksToggle).toContainText('1'); // the open-task badge counts it too
  if ((await tasksToggle.getAttribute('aria-pressed')) !== 'true') await tasksToggle.click();
  await expect(o.page.getByText('Visible task on the page')).toBeVisible();
  // Nothing else from that workspace: it isn't in her workspace list, and she can't share or manage the page.
  await expect(o.page.getByRole('button', { name: 'Share', exact: true })).toHaveCount(0);
  await expect(o.page.locator('.page-topbar').getByTitle('Page options')).toHaveCount(0);
  await o.page.locator('.ws-switch').click();
  await expect(o.page.locator('.menu').getByText('Closed Team')).toHaveCount(0);

  await o.context.close();
});
