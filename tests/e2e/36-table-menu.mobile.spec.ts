// Tables on a phone (no ribbon): the table's controls float above the table, outside it, and
// never over a cell, even while typing in the header row.
import { expect, test } from '@playwright/test';
import { createPage, createUser, focusEnd, openPage, signInContext } from './helpers.ts';

test('mobile: the table menu sits outside the table and never covers a cell', async ({ page, context, request }) => {
  const user = await createUser(request, 'Tia Table');
  const { pageId } = await createPage(request, user, { page: 'Phone table' });
  await signInContext(context, user);
  const editor = await openPage(page, user.wsId, pageId);
  await focusEnd(page);
  await page.keyboard.type('/table');
  await expect(page.locator('.slash-menu .slash-item').first()).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(editor.locator('table tr')).toHaveCount(3);
  await page.keyboard.type('Header');

  const menu = page.locator('.table-menu');
  await expect(menu).toBeVisible();
  await expect(page.getByRole('toolbar', { name: 'Ribbon' })).toBeHidden();
  const overlaps = async () => {
    const m = (await menu.boundingBox())!;
    const cells = await editor.locator('th, td').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON() as DOMRect));
    return cells.filter((c) => m.x < c.right && m.x + m.width > c.left && m.y < c.bottom && m.y + m.height > c.top).length;
  };
  expect(await overlaps()).toBe(0);
  const table = (await editor.locator('table').boundingBox())!;
  const m = (await menu.boundingBox())!;
  expect(m.y + m.height <= table.y + 1 || m.y >= table.y + table.height - 1).toBe(true);

  // Its buttons work, and it keeps clear of the table as the table grows.
  await menu.getByRole('button', { name: 'Insert row below' }).tap();
  await expect(editor.locator('table tr')).toHaveCount(4);
  await page.keyboard.type('more');
  await expect(menu).toBeVisible();
  expect(await overlaps()).toBe(0);

  // Out of the table: gone.
  await editor.locator('p').last().tap();
  await expect(menu).toBeHidden();
});
