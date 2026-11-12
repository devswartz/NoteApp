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

  test('"1) " and "a) " keep the parenthesis at their level; nested levels use the default styles', async ({ page, context, request }) => {
    const user = await createUser(request, 'Par En');
    const { pageId } = await createPage(request, user, { page: 'Parens' });
    await signInContext(context, user);
    const editor = await openPage(page, user.wsId, pageId);
    await focusEnd(page);
    await page.keyboard.press('Enter');
    await page.keyboard.type('1) First\nSecond\n');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Nested\n\n\n');
    await page.keyboard.type('a) Letter');

    const paren = editor.locator('ol[data-marker="paren-1"]');
    await expect(paren.locator(':scope > li > p')).toHaveText(['First', 'Second']);
    expect(await marker(paren)).toBe('outline-decimal-paren');
    expect(await marker(paren.locator('ol'))).toBe('lower-alpha'); // the level below: Word's default
    expect(await marker(editor.locator('ol[data-marker="paren-a"]'))).toBe('outline-alpha-paren');
    await page.waitForTimeout(1500); // saved 1 s after the last edit
    await page.reload();
    await expect(editor.locator('ol[data-marker="paren-1"] > li')).toHaveCount(2);
  });

  test('a list split by Enter keeps counting; Enter mid-item and on a nested empty item stay in the count', async ({ page, context, request }) => {
    const user = await createUser(request, 'Spl It');
    const { pageId } = await createPage(request, user, { page: 'Split' });
    await signInContext(context, user);
    const editor = await openPage(page, user.wsId, pageId);
    await focusEnd(page);
    await page.keyboard.press('Enter');
    await page.keyboard.type('1. One\nTwo\nThree');
    const first = editor.locator('ol').first();
    /** Caret at the end of the list line reading `text` (retries: a click can land before the box is ready). */
    const caretAt = async (text: string) => {
      await expect(async () => {
        await editor.locator('li p').filter({ hasText: new RegExp(`^${text}$`) }).click();
        expect(await page.evaluate(() => getSelection()?.anchorNode?.textContent)).toBe(text);
      }).toPass();
      await page.keyboard.press('End');
    };

    /**
     * Wait until the caret is in the line reading `text` at `offset`, so the next key acts there.
     * Checked in the editor's own state too: the DOM selection moves first, and an Enter that
     * arrives before the editor reads it splits at the old place.
     */
    const caretIs = (text: string, offset: number) =>
      expect
        .poll(() =>
          page.evaluate(() => {
            const sel = getSelection();
            const el = (sel?.anchorNode?.parentElement?.closest('.ProseMirror') ?? null) as (Element & { editor?: { state: { selection: { $head: { parent: { textContent: string }; parentOffset: number } } } } }) | null;
            const head = el?.editor?.state.selection.$head;
            return [sel?.anchorNode?.textContent, sel?.anchorOffset, head?.parent.textContent, head?.parentOffset];
          }),
        )
        .toEqual([text, offset, text, offset]);

    // Enter in the middle of an item splits it inside the same list.
    // (Keyboard only: a click's selection can land late and undo the arrow key.)
    await page.keyboard.press('ArrowUp'); // end of "Two"
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowLeft');
    await caretIs('Two', 2);
    await page.keyboard.press('Enter');
    await expect(first.locator(':scope > li > p')).toHaveText(['One', 'Tw', 'o', 'Three']);
    await expect(editor.locator('ol')).toHaveCount(1);

    // Enter twice at the end of "Tw": an empty item, then out of the list. The rest carries on counting.
    await page.keyboard.press('ArrowLeft'); // from the start of "o" to the end of "Tw"
    await caretIs('Tw', 2);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('A note between');
    await expect(first.locator(':scope > li > p')).toHaveText(['One', 'Tw']);
    const rest = editor.locator('ol[data-continue]');
    await expect(rest.locator(':scope > li > p')).toHaveText(['o', 'Three']);
    await expect(rest).toHaveAttribute('start', '3'); // o is 3., Three is 4.

    // A nested empty item outdents into the continued list, not a new one.
    await page.keyboard.press('ArrowDown'); // "o"
    await page.keyboard.press('ArrowDown'); // "Three"
    await page.keyboard.press('End');
    await caretIs('Three', 5);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Sub\n');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Four');
    await expect(rest.locator(':scope > li > p')).toHaveText(['o', 'Three', 'Four']);
    await expect(editor.locator('ol:not([data-continue])')).toHaveCount(2); // the first list and "Sub"'s level

    await page.waitForTimeout(1500);
    await page.reload();
    await expect(editor.locator('ol[data-continue] > li')).toHaveCount(3);
    await expect(editor.locator('ol[data-continue]')).toHaveAttribute('start', '3');
    // A new item in the first list pushes the continued numbers on.
    await caretAt('One');
    await page.keyboard.press('Enter');
    await page.keyboard.type('One more');
    await expect(editor.locator('ol[data-continue]')).toHaveAttribute('start', '4');
    await editor.screenshot({ path: test.info().outputPath('split.png') });
  });
});
