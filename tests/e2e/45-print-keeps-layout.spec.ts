// While the print dialog is open the viewport is the paper's width. The app must not take that for a phone:
// the sidebar, panel widths and ribbon collapse are exactly as they were after printing (it used to close the sidebar).
import { expect, test } from '@playwright/test';
import { createPage, createUser, openPage, signInContext } from './helpers.ts';

test('printing leaves the sidebar, its widths and the ribbon collapse as they were', async ({ page, context, request }) => {
  const user = await createUser(request, 'Pat Printer');
  const { pageId } = await createPage(request, user, { notebook: 'Print Notebook', page: 'Printed page' });
  await signInContext(context, user);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => localStorage.setItem('noteapp.ribbonCollapsed', '1'));
  await openPage(page, user.wsId, pageId);

  const sidebar = page.getByRole('navigation', { name: 'Sidebar' });
  await expect(sidebar).toBeVisible();
  for (const handle of await page.locator('.sb-resizer').all()) {
    await handle.focus();
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  }
  const snapshot = () =>
    page.evaluate(() => ({
      sidebarOpen: localStorage.getItem('noteapp.sidebarOpen'),
      ribbonCollapsed: localStorage.getItem('noteapp.ribbonCollapsed'),
      sidebarWidth: Math.round(document.querySelector('.sidebar')!.getBoundingClientRect().width),
      appClass: document.querySelector('.app')!.className,
      panels: document.querySelectorAll('.sb-resizer').length,
      url: location.pathname,
    }));
  const before = await snapshot();
  expect(before.appClass).toContain('sidebar-open');
  expect(before.appClass).not.toContain('is-mobile');

  // What the browser does around the dialog: beforeprint, a paper-width viewport, afterprint, the window back.
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  await page.setViewportSize({ width: 700, height: 900 });
  await page.waitForTimeout(500);
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(800);

  expect(await snapshot()).toEqual(before);
  await expect(sidebar).toBeVisible();
});
