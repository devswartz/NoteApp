// Trash: deleting moves a page to Trash; Undo and the Trash screen restore it; Delete forever removes it.
import { expect, test } from '@playwright/test';
import { api, createPage, createUser, listTasks, openPage, signInContext, taskRow, tasksUrl } from './helpers.ts';

test('delete a page, undo from the toast, then delete again and restore it from the Trash', async ({ page, context, request }) => {
  const user = await createUser(request, 'Tess Trasher');
  const { pageId } = await createPage(request, user, { notebook: 'Trash Notebook', page: 'Fragile page' });
  await api(request, 'POST', `/workspaces/${user.wsId}/tasks`, user.token, { title: 'Rides along', pageId, assigneeId: user.id });
  await signInContext(context, user);
  const sidebar = page.getByRole('navigation', { name: 'Sidebar' });

  await openPage(page, user.wsId, pageId);
  await page.getByRole('button', { name: 'Page options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Delete page' }).click();
  const toast = page.locator('.toast');
  await expect(toast).toContainText('Moved to Trash.');
  await expect(toast).toContainText('Its 1 task stays in your task list.');
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('.toast').last()).toContainText('Restored');
  await expect(sidebar.getByText('Fragile page')).toBeVisible();
  await openPage(page, user.wsId, pageId);

  // Delete again; it is in the Trash screen, and its task stays in the task list, its page shown as "in Trash".
  await page.getByRole('button', { name: 'Page options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Delete page' }).click();
  await expect(sidebar.getByText('Fragile page')).toHaveCount(0);
  await page.goto(tasksUrl(user.wsId, 'my'));
  await expect(taskRow(page, 'Rides along')).toBeVisible();
  await expect(taskRow(page, 'Rides along').getByRole('link', { name: /Fragile page · in Trash/ })).toBeVisible();

  await page.goto(`/w/${user.wsId}/trash`);
  const row = page.getByTestId('trash-row').filter({ hasText: 'Fragile page' });
  await expect(row).toContainText('Trash Notebook');
  await expect(row).toContainText('removed in 60 days');
  // Open it from the Trash: read-only, with a Restore button.
  await row.getByRole('link', { name: 'Fragile page' }).click();
  await expect(page.locator('.trash-banner')).toContainText('in the Trash');
  await page.locator('.trash-banner').getByRole('button', { name: 'Restore' }).click();
  await expect(page.locator('.trash-banner')).toHaveCount(0);
  await expect(sidebar.getByText('Fragile page')).toBeVisible();
  await expect.poll(async () => (await listTasks(request, user)).some((t) => t.title === 'Rides along' && t.pageId === pageId)).toBe(true);
});

test('Delete forever removes a trashed page for good', async ({ page, context, request }) => {
  const user = await createUser(request, 'Fred Forever');
  const { pageId } = await createPage(request, user, { notebook: 'Forever Notebook', page: 'Goodbye page' });
  await signInContext(context, user);
  await api(request, 'DELETE', `/pages/${pageId}`, user.token);
  await page.goto(`/w/${user.wsId}/trash`);
  const row = page.getByTestId('trash-row').filter({ hasText: 'Goodbye page' });
  await row.getByRole('button', { name: 'Delete forever' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete forever' }).click();
  await expect(page.getByTestId('trash-row')).toHaveCount(0);
  await expect(page.getByText('Nothing in the Trash')).toBeVisible();
  await page.goto(`/w/${user.wsId}/p/${pageId}`);
  await expect(page.getByText('Page not found')).toBeVisible();
});
