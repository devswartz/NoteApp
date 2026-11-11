// Priority 9: phone-size smoke test (iPhone 13 viewport, touch) — navigation, tasks, quick add, opening a note.
import { expect, test } from '@playwright/test';
import { addFilter, createPage, createTask, createUser, isoDay, listTasks, openPage, signInContext, taskRow } from './helpers.ts';

test('mobile: tab bar navigation, quick add, complete a task, open a note step by step', async ({ page, context, request }) => {
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

  // The menu opens the Tasks panel as a drawer: switch to My Tasks.
  await page.getByRole('button', { name: 'Open menu' }).tap();
  const sidebar = page.getByRole('navigation', { name: 'Sidebar' });
  await expect(sidebar).toBeInViewport();
  await sidebar.getByRole('link', { name: /My Tasks/ }).tap();
  await expect(page).toHaveURL(/\/tasks\/my$/);
  await expect(sidebar).not.toBeInViewport();
  await expect(taskRow(page, 'Call mum')).toBeVisible();

  // Notes: notebook → section → page, with Back at each step.
  await tabbar.getByRole('link', { name: 'Notes' }).tap();
  await expect(page).toHaveURL(/\/notes$/);
  await page.getByRole('link', { name: /Pocket Notebook/ }).tap();
  await expect(page.getByRole('heading', { name: 'Pocket Notebook' })).toBeVisible();
  await page.getByRole('link', { name: /General/ }).tap();
  await expect(page.getByRole('heading', { name: 'General' })).toBeVisible();
  await page.getByRole('link', { name: /Grocery list/ }).tap();
  await expect(page).toHaveURL(new RegExp(`/p/${pageId}`));
  await expect(page.locator('.ProseMirror')).toBeVisible();
  await page.getByRole('button', { name: 'Back' }).tap();
  await expect(page.getByRole('heading', { name: 'General' })).toBeVisible();
  await page.getByRole('link', { name: 'Back' }).tap();
  await expect(page.getByRole('heading', { name: 'Pocket Notebook' })).toBeVisible();
  await page.getByRole('link', { name: 'Back' }).tap();
  await expect(page.getByRole('heading', { name: 'Notes' })).toBeVisible();

  // The Tasks tab reopens the last task view.
  await tabbar.getByRole('link', { name: 'Tasks' }).tap();
  await expect(page).toHaveURL(/\/tasks\/my$/);
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

test('mobile: create a page from search, add a task with /task, see it on Today, complete it', async ({ page, context, request }) => {
  const user = await createUser(request, 'Nia Phone');
  await createPage(request, user, { notebook: 'Phone notes', page: 'Existing' });
  await signInContext(context, user);
  await page.goto(`/w/${user.wsId}/tasks/today`);
  const tabbar = page.getByRole('navigation', { name: 'Primary' });
  await expect(tabbar).toBeVisible();

  // "New page" from the palette (the phone has no hover-revealed sidebar buttons).
  await page.getByRole('button', { name: 'Search' }).first().tap();
  const palette = page.getByRole('dialog', { name: 'Search' });
  await palette.getByPlaceholder(/Search pages and tasks/).fill('new page');
  await expect(palette.locator('.palette-label', { hasText: /^New page$/ }).first()).toBeVisible();
  await palette.locator('.palette-label', { hasText: /^New page$/ }).first().tap();
  await expect(page).toHaveURL(/\/p\/[^/]+$/);
  const pageId = page.url().split('/p/')[1]!;

  await page.locator('.page-title').fill('Groceries');
  const editor = page.locator('.canvas-box .ProseMirror'); // a blank page's first box, ready for typing
  await editor.tap();
  await page.keyboard.type('/task');
  await expect(page.locator('.slash-menu .slash-title', { hasText: 'Task' }).first()).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('.task-ref-title:focus')).toBeVisible();
  await page.keyboard.type('Buy lemons today');
  await page.keyboard.press('Enter'); // commit (+ a new empty task)
  await page.keyboard.press('Enter'); // empty task + Enter leaves task mode
  await expect.poll(async () => (await listTasks(request, user)).some((t) => t.title === 'Buy lemons' && t.pageId === pageId)).toBe(true);

  await tabbar.getByRole('link', { name: 'Tasks' }).tap();
  await expect(page).toHaveURL(/\/tasks\/today$/);
  const row = taskRow(page, 'Buy lemons');
  await expect(row).toBeVisible();
  await expect(row.getByTitle('Open in note')).toContainText('Groceries');
  await row.getByRole('checkbox', { name: 'Complete task' }).tap();
  await expect.poll(async () => (await listTasks(request, user)).find((t) => t.title === 'Buy lemons')?.status).toBe('done');

  // No horizontal scroll on the note either.
  await page.goto(`/w/${user.wsId}/p/${pageId}`);
  await expect(page.locator('.ProseMirror')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});

test('mobile: no ribbon; All Tasks and Calendar keep their in-page filters and switches', async ({ page, context, request }) => {
  const user = await createUser(request, 'Phil Phone');
  await createTask(request, user, user.wsId, { title: 'Urgent phone task', priority: 1 });
  await createTask(request, user, user.wsId, { title: 'Calm phone task', priority: 4 });
  await signInContext(context, user);
  await page.goto(`/w/${user.wsId}/tasks/all`);
  await expect(page.getByRole('toolbar', { name: 'Ribbon' })).toHaveCount(0);
  await addFilter(page, 'Priority', 'Priority 1');
  await expect(page.locator('.filter-chip[data-filter="priority"]')).toContainText('Priority 1');
  await expect(taskRow(page, 'Urgent phone task')).toBeVisible();
  await expect(taskRow(page, 'Calm phone task')).toHaveCount(0);
  await expect(page.getByLabel('Sort')).toBeVisible();
  await page.goto(`/w/${user.wsId}/tasks/calendar`);
  await expect(page.locator('.cal-head').getByRole('tab', { name: 'Week' })).toBeVisible();
  await expect(page.locator('.cal-head').getByRole('button', { name: 'Next month' })).toBeVisible();
});
