// Sharing one page (#98): the owner shares a page from a private notebook with one teammate,
// who opens it from "Shared with me" and co-edits it live; revoking takes it away live.
// People outside the workspace get exactly what the share says, for that page only: with
// edit, its tasks too, which can be assigned between them and the workspace.
import { expect, test, type Browser } from '@playwright/test';
import { addInlineTask, api, createPage, createTeam, createUser, focusEnd, openNotebookPicker, openPage, signInContext, taskRef, type TestUser } from './helpers.ts';

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

  // Before sharing, Bob sees neither the notebook nor the page (in the Notes panel's notebook picker).
  await b.page.goto(`/w/${teamId}/notes`);
  await expect(b.page.locator('.sidebar, nav').first()).toBeVisible();
  await openNotebookPicker(b.page);
  await expect(b.page.getByText('Alice private')).toHaveCount(0);
  await expect(b.page.getByTestId('shared-with-me')).toHaveCount(0);
  await b.page.keyboard.press('Escape');

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
  await openNotebookPicker(b.page);
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
  await openNotebookPicker(b.page);
  await expect(b.page.getByTestId('shared-with-me')).toHaveCount(0);

  await a.context.close();
  await b.context.close();
});

test('someone outside the workspace with a view share opens the link: that page only, view-only, with its tasks', async ({ browser, request }) => {
  const alice = await createUser(request, 'Alice Owner');
  const olga = await createUser(request, 'Olga Outsider');
  const teamId = await createTeam(request, alice, [], 'Closed Team');
  const { pageId } = await createPage(request, alice, { wsId: teamId, notebook: 'Closed notebook', page: 'Public-ish note' });
  await api(request, 'POST', `/workspaces/${teamId}/tasks`, alice.token, { title: 'Visible task on the page', pageId });
  const r = await api<{ status: string }>(request, 'POST', `/pages/${pageId}/shares`, alice.token, { email: olga.email, canEdit: false });
  expect(r.status).toBe('shared');

  const o = await userPage(browser, olga);
  await o.page.goto(`/shared/${pageId}`);
  await expect(o.page).toHaveURL(new RegExp(`/w/${olga.wsId}/p/${pageId}`));
  await expect(o.page.locator('.ProseMirror')).toBeVisible();
  await expect(o.page.locator('.chip', { hasText: 'View only' })).toBeVisible();
  await expect(o.page.locator('.crumbs')).toContainText('Shared with me');
  await openNotebookPicker(o.page);
  await expect(o.page.getByTestId('shared-with-me').getByRole('link', { name: /Public-ish note/ })).toContainText('Closed Team');
  await o.page.keyboard.press('Escape');
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

test('someone outside the workspace with an edit share co-edits that page and its tasks, and tasks are assigned both ways', async ({ browser, request }) => {
  const alice = await createUser(request, 'Alice Host');
  const eddie = await createUser(request, 'Eddie Outside');
  const teamId = await createTeam(request, alice, [], 'Host Team');
  const { pageId } = await createPage(request, alice, { wsId: teamId, notebook: 'Host notebook', page: 'Joint draft', visibility: 'private' });

  const a = await userPage(browser, alice);
  await openPage(a.page, teamId, pageId);
  await addInlineTask(a.page, 'Host task');

  // Alice shares it by email, to edit, from the dialog: no "can only view" note, and the access is editable.
  await a.page.getByRole('button', { name: 'Share', exact: true }).click();
  const dialog = a.page.locator('.page-share-dialog');
  await expect(dialog).not.toContainText('can view it but not edit');
  await dialog.getByLabel('Name or email').fill(eddie.email);
  await dialog.getByLabel('Access', { exact: true }).selectOption('edit');
  await dialog.getByRole('button', { name: 'Share', exact: true }).click();
  const row = dialog.getByTestId('page-share-row');
  await expect(row).toContainText('outside the workspace');
  await expect(dialog.getByLabel('Access for Eddie Outside')).toHaveValue('edit');
  await expect(dialog.getByLabel('Access for Eddie Outside')).toBeEnabled();
  // A pending invite says what it will grant.
  await dialog.getByLabel('Name or email').fill(`pending-editor-${Date.now()}@example.com`);
  await dialog.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(dialog).toContainText('Invited: can edit once they sign up');
  await dialog.getByRole('button', { name: 'Done' }).click();

  const e = await userPage(browser, eddie);
  await e.page.goto(`/shared/${pageId}`);
  await expect(e.page).toHaveURL(new RegExp(`/w/${eddie.wsId}/p/${pageId}`));
  await expect(e.page.locator('.sync-live')).toBeVisible({ timeout: 15_000 });
  await expect(e.page.locator('.chip', { hasText: 'View only' })).toHaveCount(0);
  await expect(e.page.locator('.crumbs')).toContainText('Shared with me');

  // Co-edit live.
  await focusEnd(e.page);
  await e.page.keyboard.press('Enter');
  await e.page.keyboard.type('Eddie was here');
  await expect(a.page.locator('.ProseMirror').first()).toContainText('Eddie was here');

  // The page's tasks are his to tick and add (#98 follow-up).
  const hostTask = taskRef(e.page, 'Host task');
  await expect(hostTask.getByRole('checkbox')).toBeEnabled();
  await hostTask.getByRole('checkbox').click();
  await expect(taskRef(a.page, 'Host task').getByRole('checkbox')).toHaveAttribute('aria-checked', 'true');
  await hostTask.getByRole('checkbox').click(); // and reopen it
  await expect(taskRef(a.page, 'Host task').getByRole('checkbox')).toHaveAttribute('aria-checked', 'false');
  await addInlineTask(e.page, 'Eddie task');
  await expect(taskRef(a.page, 'Eddie task')).toBeVisible();
  const tasks = await api<{ id: string; title: string; workspaceId: string }[]>(request, 'GET', `/pages/${pageId}/tasks`, alice.token);
  expect(tasks.map((t) => t.title).sort()).toEqual(['Eddie task', 'Host task']);
  expect(tasks.every((t) => t.workspaceId === teamId)).toBe(true);

  // Assigning: Eddie → Alice (he only sees the page's people), Alice → Eddie.
  await taskRef(e.page, 'Eddie task').locator('.avatar-btn').click();
  await expect(e.page.getByRole('menuitem', { name: /Alice Host/ })).toBeVisible();
  await e.page.getByRole('menuitem', { name: /Alice Host/ }).click();
  await expect(taskRef(a.page, 'Eddie task').locator('.avatar-btn')).toHaveAttribute('title', /assigned to Alice Host/);
  await taskRef(a.page, 'Host task').locator('.avatar-btn').click();
  await a.page.getByRole('menuitem', { name: /Eddie Outside/ }).click();
  await expect(taskRef(e.page, 'Host task').locator('.avatar-btn')).toHaveAttribute('title', /assigned to Eddie Outside/);

  // It's in Eddie's own "My tasks", under the page it came from.
  await e.page.goto(`/w/${eddie.wsId}/tasks/my`);
  const mine = e.page.locator('.task-row', { hasText: 'Host task' });
  await expect(mine).toBeVisible({ timeout: 10_000 });
  await expect(mine.locator('.chip-link')).toContainText('Joint draft');
  await expect(e.page.locator('.task-row', { hasText: 'Eddie task' })).toHaveCount(0);
  await mine.locator('.chip-link').click();
  await expect(e.page).toHaveURL(new RegExp(`/p/${pageId}`));
  await expect(e.page.locator('.sync-live')).toBeVisible({ timeout: 15_000 });

  // Still nothing else from that workspace: no Share, no move or delete, not in her workspace list.
  await expect(e.page.getByRole('button', { name: 'Share', exact: true })).toHaveCount(0);
  await e.page.locator('.page-topbar').getByTitle('Page options').click();
  await expect(e.page.locator('.page-menu')).not.toContainText('Delete page');
  await expect(e.page.locator('.page-menu')).not.toContainText('Move to');
  await e.page.keyboard.press('Escape');
  await e.page.locator('.ws-switch').click();
  await expect(e.page.locator('.menu').getByText('Host Team')).toHaveCount(0);

  await a.context.close();
  await e.context.close();
});
