// Backspace/Enter on an empty last line leaves toggles, callouts and quotes, like outlines
// in Word (src/editor/blockExit.ts). Owner: Editor & Notes.
import { test, expect, type Page } from '@playwright/test';
import { createPage, createUser, focusEnd, openPage, signInContext } from './helpers.ts';

async function slash(page: Page, query: string) {
  await page.keyboard.type('/' + query);
  await expect(page.locator('.slash-menu .slash-item').first()).toBeVisible();
  await page.keyboard.press('Enter');
}

async function setup(page: Page, context: Parameters<typeof signInContext>[0], request: Parameters<typeof createUser>[0], name: string) {
  const user = await createUser(request, name);
  const { pageId } = await createPage(request, user, { page: name });
  await signInContext(context, user);
  const editor = await openPage(page, user.wsId, pageId);
  await focusEnd(page);
  return editor;
}

test.describe('leaving nested blocks', () => {
  test('toggle: Backspace on the empty last line moves it after the toggle; again joins; undo restores', async ({ page, context, request }) => {
    const editor = await setup(page, context, request, 'Toggle Exit');
    await slash(page, 'toggle');
    await page.keyboard.type('Parent');
    await page.keyboard.press('Enter');
    await page.keyboard.type('one');
    await page.keyboard.press('Enter');
    await page.keyboard.type('two');
    await page.keyboard.press('ArrowDown'); // the toggle's own empty last line
    const lines = editor.locator('.toggle [data-type="detailsContent"] p');
    await expect(lines).toHaveCount(3);
    await page.waitForTimeout(700); // its own undo step
    await page.keyboard.press('Backspace');
    await expect(lines).toHaveText(['one', 'two']);
    await page.keyboard.type('outside');
    await expect(editor.locator('.toggle + p')).toHaveText('outside');
    for (let i = 0; i < 'outside'.length; i++) await page.keyboard.press('Backspace');
    await expect(editor.locator('.toggle + p')).toHaveText('');
    await page.keyboard.press('Backspace'); // now the usual join: end of "two"
    await page.keyboard.type('!');
    await expect(lines).toHaveText(['one', 'two!']);
  });

  test('toggle: Enter on the empty last line exits; Ctrl+Z puts the line back', async ({ page, context, request }) => {
    const editor = await setup(page, context, request, 'Toggle Enter');
    await slash(page, 'toggle');
    await page.keyboard.type('Parent');
    await page.keyboard.press('Enter');
    await page.keyboard.type('one');
    await page.keyboard.press('ArrowDown'); // the toggle's own empty last line
    const lines = editor.locator('.toggle [data-type="detailsContent"] p');
    await expect(lines).toHaveText(['one', '']);
    await page.waitForTimeout(700);
    await page.keyboard.press('Enter');
    await expect(lines).toHaveText(['one']);
    await page.waitForTimeout(700); // the exit is its own undo step
    await page.keyboard.type('after');
    await expect(editor.locator('.toggle + p')).toHaveText('after');
    await page.waitForTimeout(700);
    await page.keyboard.press('ControlOrMeta+z'); // the typing
    await page.keyboard.press('ControlOrMeta+z'); // the exit
    await expect(lines).toHaveText(['one', '']);
    await expect(editor).not.toContainText('after');
  });

  for (const [kind, sel] of [
    ['callout', '.callout'],
    ['quote', 'blockquote'],
  ] as const) {
    test(`${kind}: Backspace on the empty last line moves it out`, async ({ page, context, request }) => {
      const editor = await setup(page, context, request, `Exit ${kind}`);
      await slash(page, kind);
      await page.keyboard.type('inside');
      await page.keyboard.press('Enter');
      await expect(editor.locator(`${sel} p`)).toHaveCount(2);
      await page.keyboard.press('Backspace');
      await expect(editor.locator(`${sel} p`)).toHaveText(['inside']);
      await page.keyboard.type('outside');
      await expect(editor.locator(':scope > p', { hasText: 'outside' })).toHaveCount(1); // a top-level line
      await expect(editor.locator(sel)).not.toContainText('outside');
    });
  }
});
