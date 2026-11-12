// Tasks on a page in the Trash stay in every task view (they are not hidden or deleted); their page chip says "in Trash" and opens the
// read-only page with its Restore button; after Restore the chip is normal again. When the page is deleted for good they stay as
// standalone tasks.
import { expect, test } from '@playwright/test';
import { api, createPage, createTeam, createUser, listTasks, signInContext, taskRow, tasksUrl } from './helpers.ts';

const today = () => new Date().toISOString().slice(0, 10);

test('a page with two tasks goes to Trash: the tasks stay listed with "in Trash" for everyone, live; Restore makes the chip normal again', async ({ page, browser, context, request }) => {
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
  const chip = (p: typeof page, title: string, label: RegExp) => taskRow(p, title).getByRole('link', { name: label });
  for (const p of [page, op]) {
    await expect(chip(p, 'Task for Tina', /^Has tasks$/)).toBeVisible();
    await expect(chip(p, 'Task for Omar', /^Has tasks$/)).toBeVisible();
  }

  await api(request, 'DELETE', `/pages/${pageId}`, owner.token);
  // Nothing is hidden: both tasks are still listed, live, for both members, and say where their page is.
  for (const p of [page, op]) {
    await expect(chip(p, 'Task for Tina', /Has tasks · in Trash/), 'live, no reload').toBeVisible();
    await expect(chip(p, 'Task for Omar', /Has tasks · in Trash/)).toBeVisible();
  }
  expect((await listTasks(request, owner, ws)).filter((t) => t.title.startsWith('Task for') && t.pageId === pageId)).toHaveLength(2);
  for (const view of ['today', 'my'] as const) {
    await page.goto(tasksUrl(ws, view));
    await expect(taskRow(page, 'Task for Tina')).toBeVisible();
  }

  // The chip opens the page read-only with its Restore banner; Restore puts it back and the chip is normal again.
  await page.goto(tasksUrl(ws, 'all'));
  await chip(page, 'Task for Tina', /in Trash/).click();
  await expect(page.locator('.trash-banner')).toContainText('in the Trash');
  await page.locator('.trash-banner').getByRole('button', { name: 'Restore' }).click();
  await expect(page.locator('.trash-banner')).toHaveCount(0);
  await page.goto(tasksUrl(ws, 'all'));
  await op.goto(tasksUrl(ws, 'all'));
  for (const p of [page, op]) {
    await expect(chip(p, 'Task for Tina', /^Has tasks$/), 'back to a normal chip').toBeVisible();
    await expect(chip(p, 'Task for Omar', /in Trash/)).toHaveCount(0);
  }
  await bc.close();
});

test('deleting the page for good leaves its tasks as standalone tasks', async ({ page, context, request }) => {
  const user = await createUser(request, 'Una Forever');
  const { pageId } = await createPage(request, user, { notebook: 'Forever', page: 'Short lived' });
  await api(request, 'POST', `/workspaces/${user.wsId}/tasks`, user.token, { title: 'Outlives the page', pageId, assigneeId: user.id });
  await signInContext(context, user);
  await api(request, 'DELETE', `/pages/${pageId}`, user.token);
  await page.goto(tasksUrl(user.wsId, 'all'));
  await expect(taskRow(page, 'Outlives the page').getByRole('link', { name: /Short lived · in Trash/ })).toBeVisible();
  await api(request, 'DELETE', `/trash/page/${pageId}`, user.token);
  await page.goto(tasksUrl(user.wsId, 'all'));
  await expect(taskRow(page, 'Outlives the page')).toBeVisible();
  await expect(taskRow(page, 'Outlives the page').getByRole('link')).toHaveCount(0); // no page chip: standalone
  expect((await listTasks(request, user)).find((t) => t.title === 'Outlives the page')?.pageId).toBeNull();
});
