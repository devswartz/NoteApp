// Word-style outlines (src/editor/smartLists.ts, markers in styles.css): typed markers start
// numbered lists, Tab / Shift+Tab and the ribbon nest them, markers follow the level, and Enter
// on an empty item outdents. Owner: Editor & Notes.
import { test, expect, type Locator } from '@playwright/test';
import { createPage, createUser, focusEnd, openPage, signInContext } from './helpers.ts';

const marker = (l: Locator) => l.evaluate((el) => getComputedStyle(el).listStyleType);

test.describe('outlines', () => {
  test('typing 1. nests with Tab as 1. → a. → i., Enter on empty items walks back out', async ({ page, context, request }) => {
    const user = await createUser(request, 'Out Line');
    const { pageId } = await createPage(request, user, { page: 'Outline' });
    await signInContext(context, user);
    const editor = await openPage(page, user.wsId, pageId);
    await focusEnd(page);
    await page.keyboard.press('Enter');
    await page.keyboard.type('1. One\nTwo\n');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Sub a\nSub b\n');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Deep');

    const top = editor.locator('ol').first();
    const level2 = top.locator(':scope > li > ol');
    const level3 = level2.locator(':scope > li > ol');
    await expect(top.locator(':scope > li')).toHaveCount(2);
    await expect(level2.locator(':scope > li')).toHaveCount(2);
    await expect(level3.locator(':scope > li')).toHaveText(['Deep']);
    expect(await marker(top)).toBe('decimal');
    expect(await marker(level2)).toBe('lower-alpha');
    expect(await marker(level3)).toBe('lower-roman');

    // Enter on an empty item: one level out each time, then out of the list.
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await expect(level3).toHaveCount(1);
    await expect(level2.locator(':scope > li')).toHaveCount(3); // the empty item is now level 2
    await page.keyboard.press('Enter');
    await expect(top.locator(':scope > li')).toHaveCount(3);
    await page.keyboard.press('Enter');
    await expect(top.locator(':scope > li')).toHaveCount(2);
    await page.keyboard.type('After the list');
    await expect(editor.locator('p', { hasText: 'After the list' })).toHaveCount(1);
    await expect(editor.locator('li', { hasText: 'After the list' })).toHaveCount(0);

    // Shift+Tab un-nests "Sub b": it becomes item 3 of the top level, renumbered by CSS.
    await editor.locator('li p', { hasText: 'Sub b' }).click();
    await expect(page.getByRole('button', { name: 'Decrease indent (Shift+Tab)' })).not.toHaveAttribute('aria-disabled', 'true'); // caret in the list
    await page.keyboard.press('Shift+Tab');
    await expect(top.locator(':scope > li > p')).toHaveText(['One', 'Two', 'Sub b']);

    // The ribbon nests it back.
    await page.getByRole('button', { name: 'Increase indent (Tab)' }).click();
    await expect(top.locator(':scope > li > p')).toHaveText(['One', 'Two']);
    await expect(level2.locator(':scope > li > p')).toHaveText(['Sub a', 'Sub b']);
  });

  test('"a. " and "i. " start lettered and roman lists; bullets change shape per level', async ({ page, context, request }) => {
    const user = await createUser(request, 'Let Ters');
    const { pageId } = await createPage(request, user, { page: 'Letters' });
    await signInContext(context, user);
    const editor = await openPage(page, user.wsId, pageId);
    await focusEnd(page);
    await page.keyboard.press('Enter');
    await page.keyboard.type('a. Apple\nBanana\n\n');
    await page.keyboard.type('I. Roman\n\n');
    await page.keyboard.type('2) Second\n\n');
    await page.keyboard.type('- Dot\n');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Ring\n');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Square');

    const alpha = editor.locator('ol[type="a"]');
    await expect(alpha.locator('li')).toHaveText(['Apple', 'Banana']);
    expect(await marker(alpha)).toBe('lower-alpha');
    expect(await marker(editor.locator('ol[type="I"]'))).toBe('upper-roman');
    await expect(editor.locator('ol[start="2"] li')).toHaveText(['Second']);
    const bullets = editor.locator('ul:not([data-type])');
    await expect(bullets).toHaveCount(3);
    expect(await marker(bullets.nth(0))).toBe('disc');
    expect(await marker(bullets.nth(1))).toBe('circle');
    expect(await marker(bullets.nth(2))).toBe('square');
  });
});
