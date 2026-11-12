// Tasks on a page that goes to Trash disappear everywhere at once (task views, for every member, live), and come back on Undo or Restore.
import { expect, test } from '@playwright/test';
import { addInlineTask, api, createPage, createTeam, createUser, listTasks, openPage, railTo, signInContext, taskRow, tasksUrl } from './helpers.ts';

const today = () => new Date().toISOString().slice(0, 10);

test('a page with two tasks goes to Trash: the tasks leave Today and My Tasks without a reload, for a second member too; Undo and Restore bring them back', async ({ page, browser, context, request }) => {
  const owner = await createUser(request, 'Tina Trash');
  const other = await createUser(request, 'Omar Other');
  const ws = await createTeam(request, owner, [{ user: other, role: 'member' }], 'Trash Team');
  const { pageId } = await createPage(request, owner, { wsId: ws, notebook: 'Trashy', page: 'Has tasks' });
  const mk = (title: string, assigneeId: string) => api(request, 'POST', `/workspaces/${ws}/tasks`, owner.token, { title, pageId, assigneeId, dueDate: today() });
  await mk('Task for Tina', owner.id);
  await mk('Task for Omar', other.id);
  await signInContext(context, owner);
  const bc = await browser.newContext();
  await signInContext(bc, other);
  const op = await bc.newPage();

  await page.goto(tasksUrl(ws, 'all'));
  await op.goto(tasksUrl(ws, 'all'));
  for (const p of [page, op]) {
    await expect(taskRow(p, 'Task for Tina')).toBeVisible();
    await expect(taskRow(p, 'Task for Omar')).toBeVisible();
  }
  // Delete the page from the sidebar's Notes view without leaving the Tasks screen: use the API (what the menu calls).
  await api(request, 'DELETE', `/pages/${pageId}`, owner.token);
  for (const p of [page, op]) {
    await expect(taskRow(p, 'Task for Tina'), 'hidden live, without a reload').toHaveCount(0);
    await expect(taskRow(p, 'Task for Omar')).toHaveCount(0);
  }
  // Today and My Tasks as well.
  for (const view of ['today', 'my'] as const) {
    await page.goto(tasksUrl(ws, view));
    await expect(taskRow(page, 'Task for Tina')).toHaveCount(0);
  }
  expect((await listTasks(request, owner, ws)).some((t) => t.title.startsWith('Task for'))).toBe(false);

  // Restore brings them back, live, for both.
  await page.goto(tasksUrl(ws, 'all'));
  await op.goto(tasksUrl(ws, 'all'));
  await api(request, 'POST', `/trash/page/${pageId}/restore`, owner.token);
  for (const p of [page, op]) {
    await expect(taskRow(p, 'Task for Tina'), 'back on restore').toBeVisible();
    await expect(taskRow(p, 'Task for Omar')).toBeVisible();
  }
  await bc.close();
});

test('deleting from the page menu (tasks typed into the page) hides them in the task views of the same session, no reload', async ({ page, context, request }) => {
  const user = await createUser(request, 'Una Inline');
  const { pageId } = await createPage(request, user, { notebook: 'Inline', page: 'Inline tasks' });
  await signInContext(context, user);
  await openPage(page, user.wsId, pageId);
  await addInlineTask(page, 'Inline one');
  await addInlineTask(page, 'Inline two');
  await expect.poll(async () => (await listTasks(request, user)).filter((t) => t.title.startsWith('Inline ')).length).toBe(2);

  await page.getByRole('button', { name: 'Page options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Delete page' }).click();
  await expect(page.locator('.toast')).toContainText('2 tasks on it are hidden');
  // Client-side navigation only (no reload): the sidebar's Tasks views.
  await railTo(page, 'Tasks');
  await page.getByRole('link', { name: 'All Tasks' }).click();
  await expect(page.getByRole('heading', { name: 'All Tasks' })).toBeVisible();
  await expect(taskRow(page, 'Inline one')).toHaveCount(0);
  await expect(taskRow(page, 'Inline two')).toHaveCount(0);
  expect((await listTasks(request, user)).some((t) => t.title.startsWith('Inline '))).toBe(false);

  // Undo from the toast brings them back.
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await expect(taskRow(page, 'Inline one')).toBeVisible();
  await expect(taskRow(page, 'Inline two')).toBeVisible();
});

test('deleting the open page from the sidebar (the page stays on screen) hides its tasks in the task views', async ({ page, context, request }) => {
  const user = await createUser(request, 'Sid Sidebar');
  const { pageId } = await createPage(request, user, { notebook: 'Side', page: 'Side page' });
  await signInContext(context, user);
  await openPage(page, user.wsId, pageId);
  await addInlineTask(page, 'Side one');
  await expect.poll(async () => (await listTasks(request, user)).some((t) => t.title === 'Side one')).toBe(true);
  const sidebar = page.getByRole('navigation', { name: 'Sidebar' });
  await sidebar.getByText('Side page', { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete page' }).click();
  await expect(page.locator('.toast')).toContainText('1 task on it is hidden');
  await railTo(page, 'Tasks');
  await page.getByRole('link', { name: 'All Tasks' }).click();
  await expect(page.getByRole('heading', { name: 'All Tasks' })).toBeVisible();
  await page.waitForTimeout(800);
  await expect(taskRow(page, 'Side one')).toHaveCount(0);
  await page.getByRole('link', { name: 'Today' }).click();
  await expect(taskRow(page, 'Side one')).toHaveCount(0);
});
