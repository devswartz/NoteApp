// Tester batch 5: deleting a task from its side panel (with Undo, and off the page it is on), printing the Tasks view, and
// "Page" (not "Note") in the task views and menus.
import { expect, test, type Page } from '@playwright/test';
import { addInlineTask, api, createPage, createTask, createUser, listTasks, openPage, ribbon, signInContext, taskRow, tasksUrl } from './helpers.ts';

async function stubPrint(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __printed: number }).__printed = 0;
    window.print = () => {
      (window as unknown as { __printed: number }).__printed++;
    };
  });
}
const printed = (page: Page) => page.evaluate(() => (window as unknown as { __printed: number }).__printed);

test('the task panel\'s delete button deletes the task, with an Undo toast that brings it back', async ({ page, context, request }) => {
  const user = await createUser(request, 'Dana Delete');
  await createTask(request, user, user.wsId, { title: 'Doomed task', assigneeId: user.id });
  await signInContext(context, user);
  await page.goto(tasksUrl(user.wsId, 'all'));
  await taskRow(page, 'Doomed task').click();
  await page.getByTitle('Delete task').click(); // no native confirm: it is blocked in some webviews, which made this a no-op
  await expect(taskRow(page, 'Doomed task')).toHaveCount(0);
  const toast = page.locator('.toast').filter({ hasText: 'Task deleted' });
  await expect(toast).toBeVisible();
  await expect.poll(async () => (await listTasks(request, user)).some((t) => t.title === 'Doomed task')).toBe(false);

  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(taskRow(page, 'Doomed task')).toBeVisible();
  await expect.poll(async () => (await listTasks(request, user)).some((t) => t.title === 'Doomed task')).toBe(true);
});

test('deleting a task that is on a page also removes it from the page (after the Undo window); Undo keeps both', async ({ page, context, request }) => {
  const user = await createUser(request, 'Pat Pager');
  const { pageId } = await createPage(request, user, { notebook: 'Tasks on pages', page: 'With tasks' });
  await signInContext(context, user);
  await openPage(page, user.wsId, pageId);
  await addInlineTask(page, 'Page task one');
  await addInlineTask(page, 'Page task two');
  await expect(page.locator('.task-ref')).toHaveCount(2);

  // Undo straight away: the task line is live again (same task).
  await page.locator('.task-ref', { has: page.locator('[data-value="Page task one"]') }).getByRole('button', { name: 'Open task details' }).click();
  await page.getByTitle('Delete task').click();
  const toast = page.locator('.toast').filter({ hasText: 'removed from the page' });
  await expect(toast).toBeVisible();
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('.task-ref')).toHaveCount(2);
  await expect(page.locator('.task-ref.is-missing')).toHaveCount(0);
  await expect.poll(async () => (await listTasks(request, user)).some((t) => t.title === 'Page task one')).toBe(true);

  // Not undone: the line leaves the page once the Undo window has passed.
  await page.locator('.task-ref', { has: page.locator('[data-value="Page task two"]') }).getByRole('button', { name: 'Open task details' }).click();
  await page.getByTitle('Delete task').click();
  await expect(page.locator('.task-ref')).toHaveCount(1, { timeout: 15_000 });
  await expect(page.locator('.task-ref .task-ref-title[data-value="Page task one"]')).toBeVisible();
  await expect.poll(async () => (await listTasks(request, user)).some((t) => t.title === 'Page task two')).toBe(false);
});

test('a task deleted elsewhere leaves a placeholder on its page with a Remove button', async ({ page, context, request }) => {
  const user = await createUser(request, 'Rita Remove');
  const { pageId } = await createPage(request, user, { notebook: 'Placeholders', page: 'Has a task' });
  await signInContext(context, user);
  await openPage(page, user.wsId, pageId);
  await addInlineTask(page, 'Orphaned task');
  const task = (await listTasks(request, user)).find((t) => t.title === 'Orphaned task')!;
  await api(request, 'DELETE', `/tasks/${task.id}`, user.token); // someone else deletes it
  const placeholder = page.locator('.task-ref.is-missing');
  await expect(placeholder).toBeVisible();
  await placeholder.getByRole('button', { name: 'Remove from page' }).click();
  await expect(page.locator('.task-ref')).toHaveCount(0);
});

test('Print on the Tasks view prints the view laid out for paper: its tasks, none of the app\'s chrome', async ({ page, context, request }) => {
  const user = await createUser(request, 'Pru Printer');
  await createTask(request, user, user.wsId, { title: 'Order paper', assigneeId: user.id, dueDate: '2030-01-01' });
  await createTask(request, user, user.wsId, { title: 'Buy toner', assigneeId: user.id });
  await signInContext(context, user);
  await stubPrint(page);
  await page.goto(tasksUrl(user.wsId, 'all'));
  await expect(taskRow(page, 'Order paper')).toBeVisible();

  // The ribbon's Print button, and Ctrl+P, both ask for a print of the view (not of a page).
  await ribbon(page).getByRole('button', { name: 'Print', exact: true }).click();
  await expect.poll(() => printed(page)).toBe(1);
  await page.keyboard.press('ControlOrMeta+p');
  await expect.poll(() => printed(page)).toBe(2);

  // What the browser does around the dialog: beforeprint, a paper-width viewport, print media.
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  await page.emulateMedia({ media: 'print' });
  await page.setViewportSize({ width: 794, height: 1123 });
  await page.waitForTimeout(400);
  await expect(page.locator('html.print-job')).toHaveCount(0); // no page job: the view itself is on paper
  await expect(page.locator('#print-root')).toHaveCount(0);
  for (const title of ['Order paper', 'Buy toner']) await expect(taskRow(page, title)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'All Tasks' })).toBeVisible();
  await expect(page.locator('.rail')).toBeHidden();
  await expect(page.locator('.sidebar')).toBeHidden();
  await expect(page.locator('.ribbon')).toBeHidden();
  const box = await taskRow(page, 'Order paper').boundingBox();
  expect(box!.width).toBeGreaterThan(600); // the list fills the sheet (794px wide)
  expect(box!.x).toBeLessThan(80);
  await page.emulateMedia({ media: 'screen' });
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
});

test('task views say "Page", not "Note": group by Page, the source filter and the task\'s page chip', async ({ page, context, request }) => {
  const user = await createUser(request, 'Wanda Words');
  const { pageId } = await createPage(request, user, { notebook: 'Words', page: 'Some page' });
  await api(request, 'POST', `/workspaces/${user.wsId}/tasks`, user.token, { title: 'On a page', pageId, assigneeId: user.id });
  await signInContext(context, user);
  await page.goto(tasksUrl(user.wsId, 'all'));
  await ribbon(page).getByRole('button', { name: 'Group by' }).click();
  await expect(page.getByRole('menuitem', { name: 'Page', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Note', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(taskRow(page, 'On a page').getByTitle('Open page')).toBeVisible();
  await ribbon(page).getByRole('button', { name: 'More filters' }).click();
  await page.getByRole('menuitem', { name: 'Source', exact: true }).click();
  await expect(page.getByRole('menuitemcheckbox', { name: 'On pages' })).toBeVisible();
});
