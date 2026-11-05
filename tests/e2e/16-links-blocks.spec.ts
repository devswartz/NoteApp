// Page links + backlinks (#25) and the newer editor blocks: callout, toggle (#21).
import { expect, test } from '@playwright/test';
import { api, createPage, createUser, eventually, focusEnd, openPage, signInContext } from './helpers.ts';

test.describe('page links', () => {
  test('[[ links to an existing page; the link opens it; the target lists the backlink; renames show through', async ({ page, context, request }) => {
    const user = await createUser(request, 'Lynn Linker');
    const source = await createPage(request, user, { notebook: 'Wiki', page: 'Index page' });
    const target = await api<{ id: string }>(request, 'POST', `/sections/${source.sectionId}/pages`, user.token, { title: 'Zebra handbook' });
    await signInContext(context, user);

    const editor = await openPage(page, user.wsId, source.pageId);
    await focusEnd(page);
    await page.keyboard.type('See [[Zebra');
    const menu = page.locator('.page-link-menu');
    await expect(menu.locator('.page-link-item', { hasText: 'Zebra handbook' })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(menu).toHaveCount(0);
    const link = editor.locator('.page-link', { hasText: 'Zebra handbook' });
    await expect(link).toBeVisible();

    await link.click();
    await expect(page).toHaveURL(new RegExp(`/p/${target.id}`));
    const backlinks = page.getByRole('region', { name: 'Linked from' });
    await expect(backlinks).toContainText('Linked from 1 page', { timeout: 10_000 });
    await expect(backlinks.getByRole('link', { name: /Index page/ })).toBeVisible();

    // Rename the target; the link in the source shows the new title (it stores only the page id).
    await page.locator('.page-title').fill('Zebra field guide');
    // Wait for the (debounced) title save before leaving; see BUG-3 for what happens otherwise.
    await eventually(() => api<{ page: { title: string } }>(request, 'GET', `/pages/${target.id}`, user.token), (r) => r.page.title === 'Zebra field guide', 'title saved');
    await backlinks.getByRole('link', { name: /Index page/ }).click();
    await expect(page).toHaveURL(new RegExp(`/p/${source.pageId}`));
    await expect(page.locator('.ProseMirror .page-link')).toHaveText(/Zebra field guide/);
  });

  test('[[ can create a new page from the link menu', async ({ page, context, request }) => {
    const user = await createUser(request, 'Cody Creator');
    const { pageId } = await createPage(request, user, { page: 'Hub' });
    await signInContext(context, user);
    const editor = await openPage(page, user.wsId, pageId);
    await focusEnd(page);
    await page.keyboard.type('[[Quarterly offsite');
    const create = page.locator('.page-link-item', { hasText: 'Create “Quarterly offsite”' });
    await expect(create).toBeVisible();
    await create.click();
    await expect(editor.locator('.page-link', { hasText: 'Quarterly offsite' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Sidebar' }).getByText('Quarterly offsite')).toBeVisible();
  });
});

test('callout and toggle blocks from the slash menu persist', async ({ page, context, request }) => {
  const user = await createUser(request, 'Bo Blocks');
  const { pageId } = await createPage(request, user);
  await signInContext(context, user);
  const editor = await openPage(page, user.wsId, pageId);

  await focusEnd(page);
  await page.keyboard.type('/callout');
  await expect(page.locator('.slash-menu .slash-title', { hasText: 'Callout' })).toBeVisible();
  await page.keyboard.press('Enter');
  await page.keyboard.type('Heads up: launch is Friday');
  await expect(editor.locator('.callout')).toContainText('Heads up: launch is Friday');

  await focusEnd(page);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/toggle');
  await expect(page.locator('.slash-menu .slash-title', { hasText: 'Toggle' })).toBeVisible();
  await page.keyboard.press('Enter');
  await page.keyboard.type('Click to expand');
  await expect(editor.locator('.toggle')).toContainText('Click to expand');

  await page.reload();
  await expect(page.locator('.ProseMirror .callout')).toContainText('Heads up: launch is Friday');
  await expect(page.locator('.ProseMirror .toggle')).toContainText('Click to expand');
});
