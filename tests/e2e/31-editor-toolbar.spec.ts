// The ribbon, text colour / highlight, and the one-click "turn into task".
import { expect, test, type Page } from '@playwright/test';
import { api, createPage, createUser, focusEnd, openPage, pageUrl, signInContext, taskRef } from './helpers.ts';

async function typeLine(page: Page, text: string) {
  await focusEnd(page);
  await page.keyboard.press('Enter');
  await page.keyboard.type(text);
}

test('ribbon: block type, bold, text colour and highlight (saved as names), undo', async ({ page, context, request }) => {
  const user = await createUser(request, 'Tia Toolbar');
  const { pageId } = await createPage(request, user);
  await signInContext(context, user);
  const editor = await openPage(page, user.wsId, pageId);
  const bar = page.getByRole('toolbar', { name: 'Ribbon' });
  await expect(bar).toBeVisible();

  await typeLine(page, 'Colourful words');
  await page.keyboard.press('Shift+Home');

  await bar.getByRole('button', { name: /^Block type/ }).click();
  await bar.getByRole('button', { name: 'Heading 2' }).click();
  await expect(editor.locator('h2')).toHaveText('Colourful words');
  await expect(bar.getByRole('button', { name: 'Block type: Heading 2' })).toBeVisible();

  const bold = bar.getByRole('button', { name: /^Bold/ });
  await expect(bold).toHaveAttribute('aria-pressed', 'false');
  await bold.click();
  await expect(editor.locator('h2 strong')).toHaveText('Colourful words');
  // The selection is kept, and the active state follows it.
  await expect(bold).toHaveAttribute('aria-pressed', 'true');
  await expect(editor).toBeFocused();

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

test('ribbon stays put while scrolling and is reachable with Alt+F10 and F6', async ({ page, context, request }) => {
  const user = await createUser(request, 'Sam Sticky');
  const { pageId } = await createPage(request, user);
  await signInContext(context, user);
  const editor = await openPage(page, user.wsId, pageId);
  const bar = page.getByRole('toolbar', { name: 'Ribbon' });
  const before = (await bar.boundingBox())!;
  await focusEnd(page);
  for (let i = 0; i < 40; i++) await page.keyboard.press('Enter');
  await page.keyboard.type('bottom line');
  await expect(bar).toBeInViewport();
  const after = (await bar.boundingBox())!;
  // Fixed at the top of the window, across it, whether or not the page has scrolled.
  expect(after.y).toBeLessThan(2);
  expect(Math.abs(after.y - before.y)).toBeLessThan(2);
  expect(after.width).toBeGreaterThan((await editor.boundingBox())!.width);

  // Alt+F10 with no selection: the ribbon; arrows move; Escape returns to the text.
  await page.keyboard.press('Alt+F10');
  const first = bar.getByRole('button', { name: /^Block type/ });
  await expect(first).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(bar.getByRole('button', { name: /^Bold/ })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(editor).toBeFocused();

  // F6 regions: F6 from the text lands on the ribbon at the top (its current item), Shift+F6 goes back.
  await page.keyboard.press('F6');
  await expect(bar.getByRole('button', { name: /^Bold/ })).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(first).toBeFocused();
  await page.keyboard.press('Shift+F6');
  await expect(editor).toBeFocused();
});

test('on a canvas the ribbon is live from the start (the first box) and then acts on the last-focused box', async ({ page, context, request }) => {
  const user = await createUser(request, 'Rae Ribbon');
  const { sectionId } = await createPage(request, user);
  // Untitled, so the title has the caret rather than the blank page's ready first box.
  const { id } = await api<{ id: string }>(request, 'POST', `/sections/${sectionId}/pages`, user.token, { title: '' });
  await signInContext(context, user);
  await page.goto(pageUrl(user.wsId, id));
  const surface = page.getByTestId('canvas-surface');
  await expect(surface).toBeVisible();
  await expect(page.locator('.sync-live')).toBeVisible({ timeout: 15_000 });

  // A blank page with the caret in the title: the ribbon is already live (it acts on the first box).
  await expect(page.locator('.page-title')).toBeFocused();
  const bar = page.getByRole('toolbar', { name: 'Ribbon' });
  const bold = bar.getByRole('button', { name: /^Bold/ });
  await expect(bold).toBeVisible();
  await expect(bold).not.toHaveAttribute('aria-disabled', 'true');
  await expect(bar.getByRole('button', { name: /^Block type/ })).not.toHaveAttribute('aria-disabled', 'true');

  // Two boxes; the second was focused last. The first is the blank page's ready box.
  await page.locator('.canvas-box.is-ready .ProseMirror').click();
  await expect(page.locator('.canvas-box .ProseMirror:focus')).toBeVisible();
  await page.keyboard.type('first box');
  await surface.click({ position: { x: 420, y: 320 } });
  await expect(page.locator('.canvas-box')).toHaveCount(2);
  await page.keyboard.type('second box');
  await expect(bold).not.toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Shift+Home');
  await bold.click();
  const second = page.locator('.canvas-box', { hasText: 'second box' });
  const first = page.locator('.canvas-box', { hasText: 'first box' });
  await expect(second.locator('strong')).toHaveText('second box');
  await expect(first.locator('strong')).toHaveCount(0);
  await expect(bold).toHaveAttribute('aria-pressed', 'true');

  // Back in the first box: the ribbon follows it.
  await first.locator('.ProseMirror').click();
  await expect(bold).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('End');
  await page.keyboard.press('Shift+Home');
  await bar.getByRole('button', { name: /^Italic/ }).click();
  await expect(first.locator('em')).toHaveText('first box');
  await expect(second.locator('em')).toHaveCount(0);
});

test('turn a line into a task from the ribbon and from the hover ✓', async ({ page, context, request }) => {
  const user = await createUser(request, 'Hal Hover');
  const { pageId } = await createPage(request, user);
  await signInContext(context, user);
  const editor = await openPage(page, user.wsId, pageId);
  const bar = page.getByRole('toolbar', { name: 'Ribbon' });

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

test('a canvas box just under the ribbon: the floating toolbar shows above the ribbon, not under it', async ({ page, context, request }) => {
  const user = await createUser(request, 'Pip Popup');
  const { sectionId } = await createPage(request, user);
  const { id } = await api<{ id: string }>(request, 'POST', `/sections/${sectionId}/pages`, user.token, { title: 'Top board', kind: 'canvas' });
  await signInContext(context, user);
  await page.setViewportSize({ width: 1280, height: 560 });
  await page.goto(pageUrl(user.wsId, id));
  const surface = page.getByTestId('canvas-surface');
  await expect(surface).toBeVisible();
  await expect(page.locator('.sync-live')).toBeVisible({ timeout: 15_000 });

  // A box at the very top of the canvas, scrolled up to sit just under the ribbon.
  await surface.click({ position: { x: 40, y: 6 } });
  await expect(page.locator('.canvas-box .ProseMirror:focus')).toBeVisible();
  await page.keyboard.type('Near the top');
  const ribbon = page.getByRole('toolbar', { name: 'Ribbon' });
  const box = page.locator('.canvas-box', { hasText: 'Near the top' });
  await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('.page-scroll')!;
    const ribbonBottom = document.querySelector('.ribbon')!.getBoundingClientRect().bottom;
    const boxTop = document.querySelector('.canvas-box')!.getBoundingClientRect().top;
    scroller.scrollTop += boxTop - ribbonBottom - 6;
  });
  const ribbonBox = (await ribbon.boundingBox())!;
  const ribbonBottom = ribbonBox.y + ribbonBox.height;
  expect((await box.boundingBox())!.y - ribbonBottom).toBeLessThan(30); // really close to the ribbon

  await page.keyboard.press('Shift+Home');
  const bubble = page.locator('.bubble-menu');
  await expect(bubble).toBeVisible();
  // Not covered: it flips under the selection, clear of the ribbon, and is on top at its centre.
  await expect.poll(async () => (await bubble.boundingBox())!.y).toBeGreaterThanOrEqual(ribbonBottom - 1);
  const onTop = await bubble.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && el.contains(hit);
  });
  expect(onTop).toBe(true);
  await bubble.getByRole('button', { name: /^Bold/ }).click();
  await expect(box.locator('strong')).toHaveText('Near the top');
});

test('ribbon groups are labelled (OneNote-style) and the labels drop on narrow windows', async ({ page, context, request }) => {
  const user = await createUser(request, 'Gil Groups');
  const { pageId } = await createPage(request, user);
  await signInContext(context, user);
  await page.setViewportSize({ width: 1280, height: 720 });
  await openPage(page, user.wsId, pageId);
  const ribbon = page.getByRole('toolbar', { name: 'Ribbon' });
  for (const name of ['Text', 'Lists', 'Insert', 'Page', 'View']) await expect(ribbon.getByRole('group', { name, exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 720 });
  await expect(ribbon.locator('.rb-label', { hasText: 'Lists' })).toBeVisible();
  expect((await ribbon.boundingBox())!.height).toBeLessThanOrEqual(80);
  await page.setViewportSize({ width: 1000, height: 720 });
  await expect(ribbon.locator('.rb-label').first()).toBeHidden();
  await expect(ribbon.getByRole('group', { name: 'Lists', exact: true })).toBeVisible(); // still named
});
