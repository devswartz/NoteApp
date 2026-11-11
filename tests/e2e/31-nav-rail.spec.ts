// Navigation (Track 2): the left rail switches between Notes, Tasks and Calendar, each
// remembering where you were; the Notes panels show the selected notebook, section and
// page; F6 and arrow keys move around; each view passes axe; the theme toggle works.
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { api, createPage, createUser, openNotebookPicker, openPage, railTo, signInContext } from './helpers.ts';

test('rail: switching views remembers the last place in each', async ({ page, context, request }) => {
  const user = await createUser(request, 'Rae Rail');
  const { pageId } = await createPage(request, user, { notebook: 'Rail Notebook', page: 'Rail page' });
  await signInContext(context, user);
  await openPage(page, user.wsId, pageId);
  const rail = page.getByRole('navigation', { name: 'Views' });
  await expect(rail.getByRole('button', { name: 'Notes', exact: true })).toHaveAttribute('aria-current', 'page');

  await railTo(page, 'Tasks');
  await expect(page).toHaveURL(/\/tasks\/today$/);
  await expect(rail.getByRole('button', { name: 'Tasks', exact: true })).toHaveAttribute('aria-current', 'page');
  const sidebar = page.getByRole('navigation', { name: 'Sidebar' });
  await sidebar.getByRole('link', { name: /My Tasks/ }).click();
  await expect(page).toHaveURL(/\/tasks\/my$/);
  await expect(sidebar.getByRole('link', { name: /My Tasks/ })).toHaveAttribute('aria-current', 'page');

  await railTo(page, 'Calendar');
  await expect(page).toHaveURL(/\/tasks\/calendar$/);
  await expect(sidebar.getByRole('button', { name: 'Next month' })).toBeVisible();

  await railTo(page, 'Tasks');
  await expect(page).toHaveURL(/\/tasks\/my$/);
  await railTo(page, 'Notes');
  await expect(page).toHaveURL(new RegExp(`/p/${pageId}$`));

  // Ctrl+\ hides the panels; the rail stays.
  await page.keyboard.press('ControlOrMeta+Backslash');
  await expect(sidebar).toBeHidden();
  await expect(rail).toBeVisible();
  await rail.getByRole('button', { name: 'Show sidebar' }).click();
  await expect(sidebar).toBeVisible();
});

test('notes panels: the selected notebook, section and page are highlighted', async ({ page, context, request }) => {
  const user = await createUser(request, 'Sel Ector');
  const a = await createPage(request, user, { notebook: 'Field Guide', page: 'Birds' });
  const sec = await api<{ id: string }>(request, 'POST', `/notebooks/${a.notebookId}/sections`, user.token, { name: 'Mammals' });
  const fox = await api<{ id: string }>(request, 'POST', `/sections/${sec.id}/pages`, user.token, { title: 'Fox' });
  await signInContext(context, user);
  await openPage(page, user.wsId, fox.id);

  const sidebar = page.getByRole('navigation', { name: 'Sidebar' });
  await expect(sidebar.locator('.nb-picker')).toContainText('Field Guide');
  const sections = sidebar.getByRole('tree', { name: 'Sections' });
  const pages = sidebar.getByRole('tree', { name: 'Pages' });
  await expect(sections.getByRole('treeitem', { name: /Mammals/ })).toHaveAttribute('aria-selected', 'true');
  await expect(sections.getByRole('treeitem', { name: /General/ })).toHaveAttribute('aria-selected', 'false');
  await expect(pages.getByRole('treeitem', { name: /Fox/ })).toHaveClass(/is-active/);

  // Selecting another section opens its page and moves the highlight.
  await sections.getByRole('treeitem', { name: /General/ }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${a.pageId}$`));
  await expect(sections.getByRole('treeitem', { name: /General/ })).toHaveAttribute('aria-selected', 'true');
  await expect(pages.getByRole('treeitem', { name: /Birds/ })).toHaveClass(/is-active/);
  await expect(pages.getByText('Fox')).toHaveCount(0);

  // Going back to Mammals reopens the page last opened there.
  await sections.getByRole('treeitem', { name: /Mammals/ }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${fox.id}$`));

  // The picker marks the current notebook.
  const picker = await openNotebookPicker(page);
  await expect(picker.getByRole('menuitem', { name: /Field Guide/ }).locator('.menu-check')).toBeVisible();
  await page.keyboard.press('Escape');
});

test('keyboard: F6 cycles rail → panels → editor; arrows move in the tree', async ({ page, context, request }) => {
  const user = await createUser(request, 'Kay Board');
  const a = await createPage(request, user, { notebook: 'Keys', page: 'First' });
  await api(request, 'POST', `/sections/${a.sectionId}/pages`, user.token, { title: 'Second' });
  await signInContext(context, user);
  await openPage(page, user.wsId, a.pageId);
  await page.locator('.ProseMirror').click();

  await page.keyboard.press('F6');
  expect(await page.evaluate(() => !!document.activeElement?.closest('.rail'))).toBe(true);
  await page.keyboard.press('F6');
  expect(await page.evaluate(() => !!document.activeElement?.closest('.sb-panel'))).toBe(true);
  await page.keyboard.press('F6');
  expect(await page.evaluate(() => !!document.activeElement?.closest('.pages-panel'))).toBe(true);
  // The open page's row has focus; Down moves to the next page.
  await expect(page.getByRole('tree', { name: 'Pages' }).getByRole('treeitem', { name: /First/ })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('tree', { name: 'Pages' }).getByRole('treeitem', { name: /Second/ })).toBeFocused();
  await page.keyboard.press('F6');
  await expect(page.locator('.ProseMirror')).toBeFocused();
  await page.keyboard.press('Shift+F6');
  expect(await page.evaluate(() => !!document.activeElement?.closest('.pages-panel'))).toBe(true);
});

test('rail and panels pass axe on every view; the user menu switches the theme', async ({ page, context, request }) => {
  const user = await createUser(request, 'Axel Axe');
  const { pageId } = await createPage(request, user, { notebook: 'A11y', page: 'Accessible' });
  await signInContext(context, user);
  for (const path of [`/w/${user.wsId}/p/${pageId}`, `/w/${user.wsId}/tasks/today`, `/w/${user.wsId}/tasks/calendar`]) {
    await page.goto(path);
    await expect(page.locator('.sidebar .panel-head').first()).toBeVisible();
    // Avatar colours come from user data (checked elsewhere), so they're left out here.
    const results = await new AxeBuilder({ page }).include('.rail').include('.sidebar').exclude('.avatar').analyze();
    const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), path).toEqual([]);
  }

  await page.getByRole('button', { name: 'Account and settings' }).click();
  await page.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Light' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('narrower windows fold the pages into the sections tree; hidden panels stay hidden after a reload', async ({ page, context, request }) => {
  const user = await createUser(request, 'Nora Narrow');
  const { pageId } = await createPage(request, user, { notebook: 'Narrow Notebook', page: 'Folded page' });
  await signInContext(context, user);
  await page.setViewportSize({ width: 1280, height: 800 });
  await openPage(page, user.wsId, pageId);

  const sidebar = page.getByRole('navigation', { name: 'Sidebar' });
  await expect(sidebar.getByRole('tree', { name: 'Sections' }).getByText('Folded page')).toBeVisible();
  await expect(sidebar.getByRole('tree', { name: 'Pages' })).toHaveCount(0);

  await page.keyboard.press('ControlOrMeta+Backslash');
  await expect(sidebar).toBeHidden();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Show sidebar' })).toBeVisible();
  await expect(sidebar).toBeHidden();
});
