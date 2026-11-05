// Edge cases around notes: move/delete pages and notebooks (tasks survive), ⌘↵ convert to task,
// live tree updates for another member, and the theme preference.
import { expect, test } from '@playwright/test';
import { api, createPage, createTeam, createUser, eventually, focusEnd, listTasks, openPage, signInContext, taskRow, tasksUrl } from './helpers.ts';

test('⌘/Ctrl+Enter turns the current line into a task', async ({ page, context, request }) => {
  const user = await createUser(request, 'Cora Convert');
  const { pageId } = await createPage(request, user);
  await signInContext(context, user);
  await openPage(page, user.wsId, pageId);
  await focusEnd(page);
  await page.keyboard.type('Order more coffee beans');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.locator('.task-ref .task-ref-title')).toHaveValue('Order more coffee beans');
  await eventually(
    () => listTasks(request, user),
    (ts) => ts.some((t) => t.title === 'Order more coffee beans' && t.pageId === pageId),
    'converted line saved as a task linked to the page',
  );
});

test('move a page to another notebook: breadcrumb updates and its tasks stay linked', async ({ page, context, request }) => {
  const user = await createUser(request, 'Max Mover');
  const from = await createPage(request, user, { notebook: 'Inbox Notebook', page: 'Movable page' });
  const to = await createPage(request, user, { notebook: 'Archive Notebook', page: 'Other page' });
  await api(request, 'POST', `/workspaces/${user.wsId}/tasks`, user.token, { title: 'Travels with page', pageId: from.pageId, assigneeId: user.id });
  await signInContext(context, user);

  await page.goto(`/w/${user.wsId}/p/${from.pageId}`);
  await expect(page.locator('.crumbs')).toContainText('Inbox Notebook');
  await page.getByRole('button', { name: 'Page options', exact: true }).click();
  // The target notebook's "General" section.
  const archiveGroup = page.locator('.menu > div', { has: page.locator('.menu-group-title', { hasText: 'Archive Notebook' }) });
  await archiveGroup.getByRole('menuitem', { name: 'General' }).click();
  await expect(page.locator('.toast')).toContainText('Moved to Archive Notebook');
  await expect(page.locator('.crumbs')).toContainText('Archive Notebook');

  const tree = await api<{ pages: { id: string; sectionId: string }[] }>(request, 'GET', `/workspaces/${user.wsId}/tree`, user.token);
  expect(tree.pages.find((p) => p.id === from.pageId)?.sectionId).toBe(to.sectionId);
  expect((await listTasks(request, user)).find((t) => t.title === 'Travels with page')?.pageId).toBe(from.pageId);
});

test('deleting a page or a notebook keeps its tasks as standalone tasks', async ({ page, context, request }) => {
  const user = await createUser(request, 'Del Eter');
  const p1 = await createPage(request, user, { notebook: 'Doomed Notebook', page: 'Doomed page' });
  const p2 = await createPage(request, user, { notebook: 'Second Notebook', page: 'Also doomed' });
  await api(request, 'POST', `/workspaces/${user.wsId}/tasks`, user.token, { title: 'Survivor one', pageId: p1.pageId, assigneeId: user.id });
  await api(request, 'POST', `/workspaces/${user.wsId}/tasks`, user.token, { title: 'Survivor two', pageId: p2.pageId, assigneeId: user.id });
  await signInContext(context, user);
  page.on('dialog', (d) => void d.accept());

  await page.goto(`/w/${user.wsId}/p/${p1.pageId}`);
  await page.getByRole('button', { name: 'Page options', exact: true }).click();
  await page.getByRole('menuitem', { name: /Delete/ }).click();
  await expect(page).toHaveURL(/\/notes$/);
  await eventually(() => listTasks(request, user), (ts) => ts.find((t) => t.title === 'Survivor one')?.pageId === null, 'task detached on page delete');

  const nbRow = page.locator('.sb-row', { hasText: 'Second Notebook' });
  await nbRow.hover();
  await nbRow.getByRole('button', { name: 'Notebook options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Delete notebook' }).click();
  await expect(page.getByRole('navigation', { name: 'Sidebar' }).getByText('Second Notebook')).toHaveCount(0);
  await eventually(() => listTasks(request, user), (ts) => ts.find((t) => t.title === 'Survivor two')?.pageId === null, 'task detached on notebook delete');

  await page.goto(tasksUrl(user.wsId, 'my'));
  await expect(taskRow(page, 'Survivor one')).toBeVisible();
  await expect(taskRow(page, 'Survivor two')).toBeVisible();
});

test('renaming a page updates another member’s sidebar live', async ({ browser, request }) => {
  const alice = await createUser(request, 'Alice Renamer');
  const bob = await createUser(request, 'Bob Watcher');
  const teamId = await createTeam(request, alice, [{ user: bob, role: 'member' }]);
  const { pageId } = await createPage(request, alice, { wsId: teamId, notebook: 'Shared Notebook', page: 'Old title' });

  const bc = await browser.newContext();
  await signInContext(bc, bob);
  const b = await bc.newPage();
  await b.goto(tasksUrl(teamId, 'today'));
  const bSidebar = b.getByRole('navigation', { name: 'Sidebar' });
  await expect(bSidebar.getByText('Old title')).toBeVisible();

  const ac = await browser.newContext();
  await signInContext(ac, alice);
  const a = await ac.newPage();
  await openPage(a, teamId, pageId);
  await a.locator('.page-title').fill('Brand new title');
  await expect(bSidebar.getByText('Brand new title')).toBeVisible({ timeout: 10_000 });
  await expect(bSidebar.getByText('Old title')).toHaveCount(0);
  await ac.close();
  await bc.close();
});

test('theme preference: dark mode applies and persists', async ({ page, context, request }) => {
  const user = await createUser(request, 'Theo Theme');
  await signInContext(context, user);
  await page.goto(`/w/${user.wsId}/settings`);
  const theme = page.getByRole('radiogroup', { name: 'Theme' });
  await theme.getByRole('radio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(theme.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');

  // System follows the OS.
  await theme.getByRole('radio', { name: 'System' }).click();
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});
