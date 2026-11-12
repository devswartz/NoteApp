// A page shared from another workspace must never get another page's title (or lose its own): Devon opens a page Scott shared,
// creates a new page, and goes back. The new page's field must not show the shared page's title while its own data is loading, and
// nothing typed in one page's field may be saved to the other.
import { expect, test } from '@playwright/test';
import { api, createPage, createUser, signInContext } from './helpers.ts';

test('a new page opened from a shared page never shows or saves the shared page\'s title; going back leaves it untouched', async ({ page, context, request }) => {
  const scott = await createUser(request, 'Scott Sharer');
  const devon = await createUser(request, 'Devon Editor');
  const { pageId: shared } = await createPage(request, scott, { notebook: 'Scott NB', page: 'Scott original title' });
  await api(request, 'POST', `/pages/${shared}/shares`, scott.token, { email: devon.email, canEdit: true });
  const { sectionId } = await createPage(request, devon, { notebook: 'Devon NB', page: 'Devon seed' });
  await signInContext(context, devon);
  const sharedTitle = async () => (await api<{ page: { title: string } }>(request, 'GET', `/pages/${shared}`, scott.token)).page.title;

  // The race behind it: the new page is not in the tree yet when it is opened (the tree refresh leaves it out) and its own data is slow.
  let newId = '';
  let leaveOut = 0; // the first tree refresh after the page is made is a stale snapshot that doesn't list it
  await page.route('**/api/workspaces/*/tree', async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { pages: { id: string; title: string }[] };
    const drop = !!newId && leaveOut > 0;
    if (drop) leaveOut--;
    await route.fulfill({ response: res, json: { ...body, pages: body.pages.filter((p) => !(drop && p.id === newId)) } });
  });
  await page.route('**/api/pages/*', async (route) => {
    if (route.request().method() === 'GET' && newId && route.request().url().endsWith(`/api/pages/${newId}`)) await new Promise((r) => setTimeout(r, 1800));
    await route.continue();
  });
  page.on('response', async (res) => {
    if (!newId && res.request().method() === 'POST' && /\/api\/sections\/[^/]+\/pages$/.test(res.url())) {
      newId = ((await res.json()) as { id: string }).id;
      leaveOut = 1;
    }
  });

  await page.goto(`/w/${devon.wsId}/p/${shared}`);
  await expect(page.locator('textarea.page-title')).toHaveValue('Scott original title');
  await page.getByRole('navigation', { name: 'Sidebar' }).getByRole('button', { name: 'New page' }).first().click();
  await expect.poll(() => newId).not.toBe('');
  await expect(page).toHaveURL(new RegExp(`/p/${newId}`));
  // For the next 1.5 s (tree refreshed without the page; its own data not here yet) the title field must not be the shared page's.
  const seen: string[] = [];
  for (let i = 0; i < 15; i++) {
    seen.push(await page.evaluate(() => document.querySelector<HTMLTextAreaElement>('textarea.page-title')?.value ?? '(no field)'));
    await page.waitForTimeout(100);
  }
  expect(seen.filter((v) => v === 'Scott original title'), `the new page showed the shared page's title: ${JSON.stringify([...new Set(seen)])}`).toEqual([]);

  // Another tree refresh (any change in the workspace) brings the page back into the tree; its own data arrives.
  await api(request, 'POST', `/sections/${sectionId}/pages`, devon.token, { title: 'Refresh trigger' });
  // Its own data arrives: type a title, go back to the shared page.
  await expect(page.locator('textarea.page-title')).toBeVisible({ timeout: 10_000 });
  await page.locator('textarea.page-title').fill('Devon new page');
  await page.waitForTimeout(600);
  await page.goBack();
  await expect(page.locator('textarea.page-title')).toHaveValue('Scott original title', { timeout: 10_000 });
  await page.waitForTimeout(1200);
  expect(await sharedTitle(), 'the shared page keeps its title').toBe('Scott original title');
  const mine = await api<{ page: { title: string } }>(request, 'GET', `/pages/${newId}`, devon.token);
  expect(mine.page.title).toBe('Devon new page');
  void sectionId;
});
