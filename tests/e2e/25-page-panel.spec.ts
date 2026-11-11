// #99 on desktop: the page panel is closed by default; opening/closing it is remembered on this device.
import { expect, test } from '@playwright/test';
import { createPage, createTask, createUser, openPage, signInContext } from './helpers.ts';

test('desktop: page panel is closed by default and the choice is remembered across pages', async ({ page, context, request }) => {
  const user = await createUser(request, 'Desk Top');
  const first = await createPage(request, user, { page: 'First page' });
  const second = await createPage(request, user, { page: 'Second page' });
  await createTask(request, user, user.wsId, { title: 'Write the brief', pageId: first.pageId });
  await signInContext(context, user);

  await openPage(page, user.wsId, first.pageId);
  const panel = page.locator('.page-panel');
  await expect(page.getByRole('button', { name: 'Tasks on this page (1 open)' })).toBeVisible();
  await expect(panel).toHaveCount(0);

  // Open it: it stays open on other pages and after a reload.
  await page.getByRole('button', { name: 'Tasks on this page (1 open)' }).click();
  await expect(panel.locator('.task-title', { hasText: 'Write the brief' })).toBeVisible();
  await openPage(page, user.wsId, second.pageId);
  await expect(panel).toBeVisible();
  await expect(panel.locator('.panel-empty')).toContainText('No tasks yet');
  await page.reload();
  await expect(panel).toBeVisible();

  // Switch to Comments, then close: it stays closed everywhere.
  await panel.getByRole('tab', { name: 'Comments' }).click();
  await expect(panel.locator('.comments-panel')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Comments', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Tasks on this page', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Close panel' }).click();
  await expect(panel).toHaveCount(0);
  await openPage(page, user.wsId, first.pageId);
  await expect(page.locator('.ProseMirror')).toBeVisible();
  await expect(panel).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.ProseMirror')).toBeVisible();
  await expect(panel).toHaveCount(0);
});
