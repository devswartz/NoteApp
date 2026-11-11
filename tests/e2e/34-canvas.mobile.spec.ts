// Canvas pages on a phone (docs/PLAN_CANVAS.md, phase 3): "New page" makes a canvas; its boxes
// are stacked full width in reading order with a separator, there is nothing to drag, and
// "Add a text box" sits at the end.
import { expect, test } from '@playwright/test';
import { createPage, createUser, signInContext } from './helpers.ts';

test('mobile: a new page is a canvas, stacked full width with "Add a text box" at the end', async ({ page, context, request }) => {
  const user = await createUser(request, 'Phil Phone');
  await createPage(request, user, { notebook: 'Phone boards', page: 'Existing' });
  await signInContext(context, user);
  await page.goto(`/w/${user.wsId}/tasks/today`);

  await page.getByRole('button', { name: 'Search' }).first().tap();
  const palette = page.getByRole('dialog', { name: 'Search' });
  await palette.getByPlaceholder(/Search pages and tasks/).fill('new page');
  await expect(palette.locator('.palette-label', { hasText: /^New page$/ }).first()).toBeVisible();
  await palette.locator('.palette-label', { hasText: /^New page$/ }).first().tap();
  await expect(page).toHaveURL(/\/p\/[^/]+$/);
  const surface = page.getByTestId('canvas-surface');
  await expect(surface).toBeVisible();
  await expect(page.locator('.sync-live')).toBeVisible({ timeout: 15_000 });

  const add = page.getByRole('button', { name: 'Add a text box' });
  await add.tap();
  await expect(page.locator('.canvas-box .ProseMirror:focus')).toBeVisible();
  await page.keyboard.type('First thought');
  await add.tap();
  await expect(page.locator('.canvas-box')).toHaveCount(2);
  await expect(page.locator('.canvas-box').nth(1).locator('.ProseMirror:focus')).toBeVisible();
  await page.keyboard.type('Second thought');

  const boxes = page.locator('.canvas-box');
  await expect(boxes.nth(0)).toContainText('First thought');
  await expect(boxes.nth(1)).toContainText('Second thought');
  // Nothing to drag on a phone.
  await expect(page.locator('.canvas-box-move, .canvas-box-width')).toHaveCount(0);
  // Full width, one under the other, a hairline between them, the add button last.
  const s = (await surface.boundingBox())!;
  const a = (await boxes.nth(0).boundingBox())!;
  const b = (await boxes.nth(1).boundingBox())!;
  expect(Math.abs(a.width - s.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(b.width - s.width)).toBeLessThanOrEqual(1);
  expect(b.y).toBeGreaterThanOrEqual(a.y + a.height - 1);
  expect(await boxes.nth(1).evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('1px');
  expect((await add.boundingBox())!.y).toBeGreaterThan(b.y + b.height - 1);
  // No horizontal scrolling at phone width.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
