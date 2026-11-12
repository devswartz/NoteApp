// Print… on a section or a notebook: every page, or just a contents list (titles only, nested by section).
// window.print is stubbed: the checks run on the print layout. Set E2E_SHOTS=<dir> to save a screenshot of the sheet.
import { expect, test, type Page } from '@playwright/test';
import { api, createPage, createUser, openPage, signInContext } from './helpers.ts';

async function stubPrint(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __printed: number }).__printed = 0;
    window.print = () => {
      (window as unknown as { __printed: number }).__printed++;
    };
  });
}
const printed = (page: Page) => page.evaluate(() => (window as unknown as { __printed: number }).__printed);

/** Handbook › General (Alpha, Beta; subsection Appendix: Gamma) and Archive (Old). */
async function handbook(request: Parameters<typeof createPage>[0], user: Awaited<ReturnType<typeof createUser>>) {
  const { notebookId, sectionId, pageId } = await createPage(request, user, { notebook: 'Handbook', page: 'Alpha' });
  await api(request, 'POST', `/sections/${sectionId}/pages`, user.token, { title: 'Beta' });
  const appendix = await api<{ id: string }>(request, 'POST', `/notebooks/${notebookId}/sections`, user.token, { name: 'Appendix', parentId: sectionId });
  await api(request, 'POST', `/sections/${appendix.id}/pages`, user.token, { title: 'Gamma' });
  const archive = await api<{ id: string }>(request, 'POST', `/notebooks/${notebookId}/sections`, user.token, { name: 'Archive' });
  await api(request, 'POST', `/sections/${archive.id}/pages`, user.token, { title: 'Old' });
  return { pageId };
}

test('Print… on a section: a contents list of its pages and subsections, titles only; All pages still prints everything', async ({ page, context, request }) => {
  const user = await createUser(request, 'Tess Contents');
  const { pageId } = await handbook(request, user);
  await signInContext(context, user);
  await stubPrint(page);
  await openPage(page, user.wsId, pageId);
  await page.keyboard.type('Secret page content');

  const tree = page.getByRole('navigation', { name: 'Sidebar' }).getByRole('tree', { name: 'Sections' });
  await tree.getByText('General', { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Print…' }).click();
  const choice = page.getByRole('dialog', { name: 'Print section' });
  await expect(choice).toBeVisible();
  await choice.getByRole('button', { name: 'Contents only' }).click();
  await expect.poll(() => printed(page)).toBe(1);

  await page.emulateMedia({ media: 'print' });
  const root = page.locator('#print-root');
  await expect(root.locator('.print-title')).toHaveText('General');
  await expect(root.locator('.print-sub')).toHaveText('1 subsection · 3 pages');
  // The hierarchy: pages first, then the subsection and its page, nested one level in.
  await expect(root.locator('.toc-title')).toHaveText(['Alpha', 'Beta', 'Appendix', 'Gamma']);
  await expect(root.locator('.toc-section > .toc-list .toc-page .toc-title')).toHaveText(['Gamma']);
  expect(await root.locator('.toc-section').count()).toBe(1);
  // Titles only: no page content, and not the other section.
  await expect(root).not.toContainText('Secret page content');
  await expect(root).not.toContainText('Archive');
  await expect(root.locator('.print-page')).toHaveCount(1);
  if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/contents-section.png`, clip: { x: 0, y: 0, width: 800, height: 420 } });

  // "All pages" prints every page, as before; dismissing the question prints nothing.
  await page.emulateMedia({ media: 'screen' });
  await tree.getByText('General', { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Print…' }).click();
  await page.getByRole('dialog', { name: 'Print section' }).getByRole('button', { name: 'All pages' }).click();
  await expect.poll(() => printed(page)).toBe(2);
  await page.emulateMedia({ media: 'print' });
  await expect(root.locator('.print-title')).toHaveText(['Alpha', 'Beta', 'Gamma']);

  await page.emulateMedia({ media: 'screen' });
  await tree.getByText('General', { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Print…' }).click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  expect(await printed(page)).toBe(2);
});

test('Print… on a notebook: its sections and their pages as a contents list, or every page of every section', async ({ page, context, request }) => {
  const user = await createUser(request, 'Nell Notebook');
  const { pageId } = await handbook(request, user);
  await signInContext(context, user);
  await stubPrint(page);
  await openPage(page, user.wsId, pageId);

  await page.getByRole('button', { name: 'Notebook options' }).first().click();
  await page.getByRole('menuitem', { name: 'Print…' }).click();
  const choice = page.getByRole('dialog', { name: 'Print notebook' });
  await expect(choice).toContainText('every page of “Handbook”');
  await choice.getByRole('button', { name: 'Contents only' }).click();
  await expect.poll(() => printed(page)).toBe(1);

  await page.emulateMedia({ media: 'print' });
  const root = page.locator('#print-root');
  await expect(root.locator('.print-title')).toHaveText('Handbook');
  await expect(root.locator('.print-sub')).toHaveText('3 sections · 4 pages');
  await expect(root.locator('.toc-title')).toHaveText(['General', 'Alpha', 'Beta', 'Appendix', 'Gamma', 'Archive', 'Old']);
  await expect(root.locator('.toc-section')).toHaveCount(3);
  if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/contents-notebook.png`, clip: { x: 0, y: 0, width: 800, height: 520 } });

  await page.emulateMedia({ media: 'screen' });
  await page.getByRole('button', { name: 'Notebook options' }).first().click();
  await page.getByRole('menuitem', { name: 'Print…' }).click();
  await page.getByRole('dialog', { name: 'Print notebook' }).getByRole('button', { name: 'All pages' }).click();
  await expect.poll(() => printed(page)).toBe(2);
  await page.emulateMedia({ media: 'print' });
  await expect(root.locator('.print-title')).toHaveText(['Alpha', 'Beta', 'Gamma', 'Old']);
});
