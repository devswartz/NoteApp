// Fixed editor toolbar, text colour / highlight, and the one-click "turn into task".
import { expect, test, type Page } from '@playwright/test';
import { createPage, createUser, focusEnd, openPage, signInContext, taskRef } from './helpers.ts';

async function typeLine(page: Page, text: string) {
  await focusEnd(page);
  await page.keyboard.press('Enter');
  await page.keyboard.type(text);
}

test('fixed toolbar: block type, bold, text colour and highlight (saved as names), undo', async ({ page, context, request }) => {
  const user = await createUser(request, 'Tia Toolbar');
  const { pageId } = await createPage(request, user);
  await signInContext(context, user);
  const editor = await openPage(page, user.wsId, pageId);
  const bar = page.getByRole('toolbar', { name: 'Editor toolbar' });
  await expect(bar).toBeVisible();

  await typeLine(page, 'Colourful words');
  await page.keyboard.press('Shift+Home');

  await bar.getByRole('button', { name: /^Block type/ }).click();
  await bar.getByRole('button', { name: 'Heading 2' }).click();
  await expect(editor.locator('h2')).toHaveText('Colourful words');
  await expect(bar.getByRole('button', { name: 'Block type: Heading 2' })).toBeVisible();

  await bar.getByRole('button', { name: /^Bold/ }).click();
  await expect(editor.locator('h2 strong')).toHaveText('Colourful words');

  await bar.getByRole('button', { name: 'Text colour', exact: true }).click();
  await bar.getByRole('button', { name: 'Text colour: Red' }).click();
  await expect(editor.locator('span[data-color="red"]')).toHaveText('Colourful words');

  await bar.getByRole('button', { name: 'Highlight', exact: true }).click();
  await bar.getByRole('button', { name: 'Highlight: Yellow' }).click();
  await expect(editor.locator('mark[data-color="yellow"]')).toHaveText('Colourful words');
  // The colour comes from the theme's CSS variable, not an inline hex value.
  expect(await editor.locator('span[data-color="red"]').getAttribute('style')).toBeNull();

  // Saved and synced: still there after a reload.
  await page.waitForTimeout(800);
  await page.reload();
  await expect(page.locator('.sync-live')).toBeVisible({ timeout: 15_000 });
  await expect(editor.locator('span[data-color="red"]')).toHaveText('Colourful words');
  await expect(editor.locator('mark[data-color="yellow"]')).toHaveText('Colourful words');

  // Default removes the colour; undo brings it back.
  await editor.locator('h2').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Shift+Home');
  await bar.getByRole('button', { name: 'Text colour', exact: true }).click();
  await bar.getByRole('button', { name: 'Text colour: Default' }).click();
  await expect(editor.locator('span[data-color]')).toHaveCount(0);
  await bar.getByRole('button', { name: /^Undo/ }).click();
  await expect(editor.locator('span[data-color="red"]')).toHaveCount(1);
});

test('toolbar stays visible while scrolling and is reachable with Alt+F10', async ({ page, context, request }) => {
  const user = await createUser(request, 'Sam Sticky');
  const { pageId } = await createPage(request, user);
  await signInContext(context, user);
  const editor = await openPage(page, user.wsId, pageId);
  await focusEnd(page);
  for (let i = 0; i < 40; i++) await page.keyboard.press('Enter');
  await page.keyboard.type('bottom line');
  const bar = page.getByRole('toolbar', { name: 'Editor toolbar' });
  await expect(bar).toBeInViewport();
  const top = (await bar.boundingBox())!.y;
  expect(top).toBeLessThan(120);

  // Alt+F10 with no selection: the fixed toolbar; arrows move; Escape returns to the text.
  await page.keyboard.press('Alt+F10');
  const first = bar.getByRole('button', { name: /^Block type/ });
  await expect(first).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(bar.getByRole('button', { name: /^Bold/ })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(editor).toBeFocused();
});

test('turn a line into a task from the toolbar and from the hover ✓', async ({ page, context, request }) => {
  const user = await createUser(request, 'Hal Hover');
  const { pageId } = await createPage(request, user);
  await signInContext(context, user);
  const editor = await openPage(page, user.wsId, pageId);
  const bar = page.getByRole('toolbar', { name: 'Editor toolbar' });

  await typeLine(page, 'Book the venue');
  await bar.getByRole('button', { name: 'Task' }).click();
  await expect(taskRef(page, 'Book the venue')).toBeVisible();

  await typeLine(page, 'Send the invites');
  const line = editor.locator('p', { hasText: 'Send the invites' });
  await line.hover();
  const check = page.getByRole('button', { name: 'Turn this line into a task' });
  await expect(check).toBeVisible();
  await check.click();
  await expect(taskRef(page, 'Send the invites')).toBeVisible();
  await expect(editor.locator('p', { hasText: 'Send the invites' })).toHaveCount(0);
});

test('the floating toolbar has text colour and highlight too', async ({ page, context, request }) => {
  const user = await createUser(request, 'Bo Bubble');
  const { pageId } = await createPage(request, user);
  await signInContext(context, user);
  const editor = await openPage(page, user.wsId, pageId);
  await typeLine(page, 'Bright idea');
  await page.keyboard.press('Shift+Home');
  const bubble = page.locator('.bubble-menu');
  await bubble.getByRole('button', { name: 'Colour' }).click();
  await bubble.getByRole('button', { name: 'Highlight: Green' }).click();
  await expect(editor.locator('mark[data-color="green"]')).toHaveText('Bright idea');
});
