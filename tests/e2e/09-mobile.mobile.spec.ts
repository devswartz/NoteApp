// Priority 9: phone-size smoke test (iPhone 13 viewport, touch) — navigation, tasks, quick add, opening a note.
import { expect, test } from '@playwright/test';
import { createPage, createTask, createUser, isoDay, openPage, signInContext, taskRow } from './helpers.ts';

test('mobile: tab bar navigation, quick add, complete a task, open a note from the menu', async ({ page, context, request }) => {
  const user = await createUser(request, 'Milo Mobile');
  const { pageId } = await createPage(request, user, { notebook: 'Pocket Notebook', page: 'Grocery list' });
  await createTask(request, user, user.wsId, { title: 'Buy oat milk', dueDate: isoDay(0) });
  await signInContext(context, user);

  // Mobile opens Today, with the mobile chrome instead of the desktop sidebar.
  await page.goto(`/w/${user.wsId}`);
  await expect(page).toHaveURL(/\/tasks\/today$/);
  const tabbar = page.getByRole('navigation', { name: 'Primary' });
  await expect(tabbar).toBeVisible();
  await expect(page.locator('.mobile-top')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Sidebar' })).not.toBeInViewport();
  await expect(taskRow(page, 'Buy oat milk')).toBeVisible();

  // No horizontal scrolling at phone width.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  // Quick add from the tab bar.
  await tabbar.getByRole('button', { name: 'Add task' }).tap();
  const qa = page.getByRole('dialog', { name: 'Quick add task' });
  await qa.locator('.qa-input').fill('Call mum today');
  await qa.getByRole('button', { name: 'Add task' }).tap();
  await expect(taskRow(page, 'Call mum')).toBeVisible();

  // Complete by tapping the checkbox.
  await taskRow(page, 'Buy oat milk').getByRole('checkbox', { name: 'Complete task' }).tap();
  await expect(taskRow(page, 'Buy oat milk')).toHaveCount(0, { timeout: 10_000 });

  // Tabs.
  await tabbar.getByRole('link', { name: 'My Tasks' }).tap();
  await expect(page).toHaveURL(/\/tasks\/my$/);
  await expect(taskRow(page, 'Call mum')).toBeVisible();
  await tabbar.getByRole('link', { name: 'Notes' }).tap();
  await expect(page).toHaveURL(/\/notes$/);

  // The menu opens the sidebar as a drawer; open the note from it.
  await page.getByRole('button', { name: 'Open menu' }).tap();
  const sidebar = page.getByRole('navigation', { name: 'Sidebar' });
  await expect(sidebar).toBeInViewport();
  await sidebar.getByText('Grocery list').tap();
  await expect(page).toHaveURL(new RegExp(`/p/${pageId}`));
  await expect(page.locator('.ProseMirror')).toBeVisible();
});

test('mobile: editing a note with the on-screen layout', async ({ page, context, request }) => {
  const user = await createUser(request, 'Mia Mobile');
  const { pageId } = await createPage(request, user, { page: 'Phone note' });
  await signInContext(context, user);
  const editor = await openPage(page, user.wsId, pageId);
  await editor.tap();
  await page.keyboard.type('Typed on a phone');
  await expect(editor).toContainText('Typed on a phone');
  await page.reload();
  await expect(page.locator('.ProseMirror')).toContainText('Typed on a phone');
});

test('mobile: search from the tab bar', async ({ page, context, request }) => {
  const user = await createUser(request, 'Sid Search');
  await createTask(request, user, user.wsId, { title: 'Renew passport' });
  await signInContext(context, user);
  await page.goto(`/w/${user.wsId}/tasks/today`);
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Search' }).tap();
  const palette = page.getByRole('dialog', { name: 'Search' });
  await palette.getByPlaceholder(/Search pages and tasks/).fill('passport');
  await expect(palette.locator('.palette-label', { hasText: 'Renew passport' })).toBeVisible();
});
