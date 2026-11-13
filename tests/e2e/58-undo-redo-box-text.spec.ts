// F9: a box's typing history belongs to the page, not to the box's editor. Undoing a new box
// away and redoing it brings its text back (and it stays after a reload); typing in a box that
// is scrolled out of view still undoes and redoes in page order.
import { expect, test, type Page } from '@playwright/test';
import { api, createPage, pageUrl, signInContext, createUser } from './helpers.ts';

async function openCanvas(page: Page, wsId: string, pageId: string) {
  await page.goto(pageUrl(wsId, pageId));
  await expect(page.getByTestId('canvas-surface')).toBeVisible();
  await expect(page.locator('.sync-live')).toBeVisible({ timeout: 15_000 });
}

/** Click empty canvas space at (x, y) and type into the new box. */
async function newBox(page: Page, x: number, y: number, text: string) {
  const stored = page.locator('.canvas-box:not(.is-ready)');
  const before = await stored.count();
  await page.getByTestId('canvas-surface').click({ position: { x, y } });
  await expect(stored).toHaveCount(before + 1);
  await expect(page.locator('.canvas-box .ProseMirror:focus')).toHaveText('');
  await page.keyboard.type(text);
  return page.locator('.canvas-box', { hasText: text });
}

async function blankCanvas(page: Page, request: Parameters<typeof createUser>[0], name: string) {
  const user = await createUser(request, name);
  const { sectionId } = await createPage(request, user, { notebook: 'Undo' });
  const { id } = await api<{ id: string }>(request, 'POST', `/sections/${sectionId}/pages`, user.token, { title: 'Undo', kind: 'canvas' });
  await signInContext(page.context(), user);
  await openCanvas(page, user.wsId, id);
  return { user, id };
}

test('redo after undoing new boxes brings their text back, and it persists', async ({ page, request }) => {
  const { user, id } = await blankCanvas(page, request, 'Rhea Redo');
  const stored = page.locator('.canvas-box:not(.is-ready)');

  await newBox(page, 40, 240, 'Alpha');
  await page.waitForTimeout(600);
  await newBox(page, 360, 420, 'Bravo');
  await page.waitForTimeout(600);
  await expect(stored).toHaveCount(2);

  // Bravo's text, Bravo's box, Alpha's text, Alpha's box.
  for (let i = 0; i < 4; i++) await page.keyboard.press('ControlOrMeta+z');
  await expect(stored).toHaveCount(0);

  // Redo puts it all back: the boxes and their text.
  for (let i = 0; i < 4; i++) await page.keyboard.press(i % 2 ? 'ControlOrMeta+y' : 'ControlOrMeta+Shift+z');
  await expect(stored).toHaveCount(2);
  await expect(page.locator('.canvas-box', { hasText: 'Alpha' })).toHaveCount(1);
  await expect(page.locator('.canvas-box', { hasText: 'Bravo' })).toHaveCount(1);

  // And it was saved.
  await page.waitForTimeout(1500);
  await openCanvas(page, user.wsId, id);
  await expect(page.locator('.canvas-box', { hasText: 'Alpha' })).toHaveCount(1);
  await expect(page.locator('.canvas-box', { hasText: 'Bravo' })).toHaveCount(1);

  // The same steps with the ribbon's Undo / Redo, after deleting a box with its text.
  const bravo = page.locator('.canvas-box', { hasText: 'Bravo' });
  await bravo.locator('.ProseMirror').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' two');
  await expect(bravo).toContainText('Bravo two');
  await page.keyboard.press('Escape');
  await expect(bravo).toBeFocused();
  await page.keyboard.press('Delete');
  await expect(stored).toHaveCount(1);
  await page.keyboard.press('ControlOrMeta+z'); // the box comes back with its text
  await expect(page.locator('.canvas-box', { hasText: 'Bravo two' })).toHaveCount(1);
  await page.keyboard.press('ControlOrMeta+z'); // then the typing in it
  await expect(page.locator('.canvas-box', { hasText: 'Bravo' })).not.toContainText('two');
  await page.keyboard.press('ControlOrMeta+y');
  await page.keyboard.press('ControlOrMeta+y');
  await expect(stored).toHaveCount(1);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('.canvas-box', { hasText: 'Bravo two' })).toHaveCount(1);
});

test('typing in a box scrolled out of view undoes and redoes in page order', async ({ page, request }) => {
  await blankCanvas(page, request, 'Otto Offscreen');
  const alpha = await newBox(page, 40, 240, 'Alpha');
  await page.waitForTimeout(600);

  // A tall box below it, so Alpha scrolls out of view while the end of this one is in view.
  const tall = await newBox(page, 40, 400, 'Tall');
  for (let i = 0; i < 60; i++) await page.keyboard.press('Enter');
  await page.keyboard.type('Bottom');
  await page.waitForTimeout(600);
  await alpha.locator('.ProseMirror').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' more');
  await expect(alpha).toContainText('Alpha more');
  await page.waitForTimeout(600);

  await tall.locator('p', { hasText: 'Bottom' }).scrollIntoViewIfNeeded();
  await tall.locator('p', { hasText: 'Bottom' }).click();
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  await page.waitForTimeout(600);
  await expect(alpha).not.toBeInViewport();

  // Ctrl+Z: the "!" here, then " more" in the box out of view.
  await page.keyboard.press('ControlOrMeta+z');
  await expect(tall.locator('p', { hasText: 'Bottom' })).toHaveText('Bottom');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(alpha.locator('.ProseMirror')).toHaveText('Alpha');

  // Scroll back and forth; redo still brings both back, in order.
  await alpha.scrollIntoViewIfNeeded();
  await tall.locator('p', { hasText: 'Bottom' }).scrollIntoViewIfNeeded();
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(alpha.locator('.ProseMirror')).toHaveText('Alpha more');
  await expect(tall.locator('p', { hasText: 'Bottom' })).toHaveText('Bottom');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(tall.locator('p', { hasText: 'Bottom' })).toHaveText('Bottom!');
});
