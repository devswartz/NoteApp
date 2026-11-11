// Notes panel (#40, re-homed by the nav rail): right-click context menu, favourites, recent pages, rename and duplicate.
import { expect, test } from '@playwright/test';
import { api, createPage, createUser, eventually, openNotebookPicker, railTo, signInContext, tasksUrl } from './helpers.ts';

test('context menu: favourite a page, rename it inline, duplicate it', async ({ page, context, request }) => {
  const user = await createUser(request, 'Sid Sidebar');
  const { pageId, sectionId } = await createPage(request, user, { notebook: 'Garden', page: 'Seed list' });
  await signInContext(context, user);
  await page.goto(tasksUrl(user.wsId, 'today'));
  await railTo(page, 'Notes');
  await (await openNotebookPicker(page)).getByRole('menuitem', { name: /Garden/ }).click();
  const sidebar = page.getByRole('navigation', { name: 'Sidebar' });
  const tree = sidebar.getByRole('tree', { name: 'Pages' });
  const row = tree.getByText('Seed list', { exact: true });
  await expect(row).toBeVisible();

  // Favourite via right-click.
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Add to favourites' }).click();
  const favHeading = sidebar.getByRole('button', { name: /Favourites/ });
  await expect(favHeading).toBeVisible();
  const favGroup = sidebar.locator('.sb-group').filter({ has: page.locator('.sb-heading-btn', { hasText: 'Favourites' }) });
  await expect(favGroup.getByText('Seed list')).toBeVisible();
  // Favourites are a per-device preference saved (debounced) to local storage; wait for it before reloading.
  await expect.poll(() => page.evaluate(([ws, id]) => JSON.parse(localStorage.getItem('noteapp.sidebar') ?? '{}').favorites?.[ws]?.includes(id), [user.wsId, pageId])).toBe(true);
  await page.reload();
  await expect(sidebar.getByRole('button', { name: /Favourites/ })).toBeVisible();

  // Rename inline.
  await tree.getByText('Seed list', { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  const input = sidebar.getByRole('textbox', { name: 'New name' });
  await input.fill('Seed catalogue');
  await input.press('Enter');
  await expect(tree.getByText('Seed catalogue', { exact: true })).toBeVisible();
  await eventually(() => api<{ page: { title: string } }>(request, 'GET', `/pages/${pageId}`, user.token), (r) => r.page.title === 'Seed catalogue', 'renamed on server');

  // Duplicate.
  await tree.getByText('Seed catalogue', { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Duplicate' }).click();
  await eventually(
    () => api<{ pages: { sectionId: string; title: string }[] }>(request, 'GET', `/workspaces/${user.wsId}/tree`, user.token),
    (t) => t.pages.filter((p) => p.sectionId === sectionId).length === 2,
    'copy created in the same section',
  );
  await expect(tree.locator('[role="treeitem"], .sb-row').filter({ hasText: /Seed catalogue/ })).toHaveCount(2);

  // Unfavourite: the Favourites group goes away.
  await favGroup.getByText('Seed catalogue').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Remove from favourites' }).click();
  await expect(sidebar.getByRole('button', { name: /Favourites/ })).toHaveCount(0);
});

test('recently opened pages are listed under Recent', async ({ page, context, request }) => {
  const user = await createUser(request, 'Rena Recent');
  const a = await createPage(request, user, { notebook: 'Recent NB', page: 'Visited first' });
  const b = await api<{ id: string }>(request, 'POST', `/sections/${a.sectionId}/pages`, user.token, { title: 'Visited second' });
  await signInContext(context, user);
  await page.goto(`/w/${user.wsId}/p/${a.pageId}`);
  await expect(page.locator('.page-title')).toHaveValue('Visited first');
  await page.goto(`/w/${user.wsId}/p/${b.id}`);
  await expect(page.locator('.page-title')).toHaveValue('Visited second');
  // Recent leaves out the page you're on, so go somewhere else: the Notes overview.
  await expect.poll(() => page.evaluate(([ws, id]) => JSON.parse(localStorage.getItem('noteapp.sidebar') ?? '{}').recent?.[ws]?.includes(id), [user.wsId, b.id])).toBe(true);
  await page.goto(`/w/${user.wsId}/notes`);

  const sidebar = page.getByRole('navigation', { name: 'Sidebar' });
  const recent = sidebar.getByRole('button', { name: 'Recent', exact: true });
  if ((await recent.getAttribute('aria-expanded')) !== 'true') await recent.click();
  await expect(recent).toHaveAttribute('aria-expanded', 'true');
  const group = sidebar.locator('.sb-group').filter({ has: page.locator('.sb-heading-btn', { hasText: 'Recent' }) });
  await expect(group.getByText('Visited first')).toBeVisible();
  await expect(group.getByText('Visited second')).toBeVisible();
});

test('New notebook dialog: "Team project" template creates its sections and pages', async ({ page, context, request }) => {
  const user = await createUser(request, 'Nell Notebook');
  await signInContext(context, user);
  await page.goto(`/w/${user.wsId}/notes`);
  await (await openNotebookPicker(page)).getByRole('menuitem', { name: 'New notebook' }).click();
  const dialog = page.getByRole('dialog', { name: 'New notebook' });
  await dialog.getByLabel('Name').fill('Apollo');
  await dialog.getByRole('radio', { name: /Team project/ }).click();
  await expect(dialog.getByRole('radio', { name: /Team project/ })).toHaveAttribute('aria-checked', 'true');
  await expect(dialog).toContainText('Creates Planning, Docs, Retros');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/p\/[^/]+$/);

  const sidebar = page.getByRole('navigation', { name: 'Sidebar' });
  await expect(sidebar.locator('.nb-picker')).toContainText('Apollo');
  const sections = sidebar.getByRole('tree', { name: 'Sections' });
  for (const name of ['Planning', 'Docs', 'Retros']) await expect(sections.getByText(name, { exact: true })).toBeVisible();
  // Each section lists its own pages in the pages panel.
  await sections.getByText('Docs', { exact: true }).click();
  await expect(sidebar.getByRole('tree', { name: 'Pages' }).getByText('Specs', { exact: true })).toBeVisible();
  const t = await api<{ notebooks: { id: string; name: string }[]; sections: { notebookId: string; name: string }[] }>(request, 'GET', `/workspaces/${user.wsId}/tree`, user.token);
  const nb = t.notebooks.find((n) => n.name === 'Apollo')!;
  expect(t.sections.filter((s) => s.notebookId === nb.id).map((s) => s.name)).toEqual(['Planning', 'Docs', 'Retros']);
});
