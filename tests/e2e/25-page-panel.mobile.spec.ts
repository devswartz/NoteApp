// #99: on a phone the "Tasks on this page" sheet never opens by itself. The toolbar
// button shows the open-task count and opens it; tap outside or swipe down closes it;
// Comments are a separate tab/button.
import { expect, test, type Page } from '@playwright/test';
import { createPage, createTask, createUser, openPage, signInContext } from './helpers.ts';

async function swipeDown(page: Page, selector: string) {
  const box = (await page.locator(selector).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.locator(selector).dispatchEvent('touchstart', { touches: [{ identifier: 1, clientX: x, clientY: y }] });
  await page.locator(selector).dispatchEvent('touchmove', { touches: [{ identifier: 1, clientX: x, clientY: y + 150 }] });
  await page.locator(selector).dispatchEvent('touchend', { touches: [] });
}

test('mobile: a page with tasks opens as just the note; the badge opens the sheet, which dismisses', async ({ page, context, request }) => {
  const user = await createUser(request, 'Pia Phone');
  const { pageId } = await createPage(request, user, { page: 'Trip notes' });
  await createTask(request, user, user.wsId, { title: 'Book the ferry', pageId });
  await createTask(request, user, user.wsId, { title: 'Pack sunscreen', pageId });
  await signInContext(context, user);

  await openPage(page, user.wsId, pageId);
  const sheet = page.locator('.page-panel');
  const tasksBtn = page.getByRole('button', { name: 'Tasks on this page (2 open)' });
  await expect(tasksBtn).toBeVisible();
  await expect(tasksBtn.locator('.panel-badge')).toHaveText('2');
  await expect(sheet).toHaveCount(0);
  // "Add icon" is a comfortable tap target (390px audit).
  expect((await page.getByRole('button', { name: /Add icon/ }).boundingBox())!.height).toBeGreaterThanOrEqual(44);

  // Tap the badge → the sheet with the page's tasks; Comments are a separate tab.
  await tasksBtn.tap();
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('tab', { name: 'Tasks' })).toHaveAttribute('aria-selected', 'true');
  await expect(sheet.locator('.task-title', { hasText: 'Book the ferry' })).toBeVisible();
  await expect(sheet.locator('.comments-panel')).toHaveCount(0);
  await sheet.getByRole('tab', { name: 'Comments' }).tap();
  await expect(sheet.locator('.comments-panel')).toBeVisible();
  await expect(sheet.locator('.task-title', { hasText: 'Book the ferry' })).toHaveCount(0);

  // Tap outside closes it.
  await page.locator('.page-sheet-backdrop').tap({ position: { x: 20, y: 120 } });
  await expect(sheet).toHaveCount(0);

  // Swipe down on the header closes it.
  await tasksBtn.tap();
  await expect(sheet).toBeVisible();
  await swipeDown(page, '.page-panel .panel-grab');
  await expect(sheet).toHaveCount(0);

  // Even after it was left open, the next page open (or a reload) shows only the note.
  await tasksBtn.tap();
  await expect(sheet).toBeVisible();
  await page.reload();
  await expect(page.locator('.ProseMirror')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Tasks on this page (2 open)' })).toBeVisible();
  await expect(sheet).toHaveCount(0);
});
