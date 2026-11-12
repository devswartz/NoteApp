// The on-screen keyboard on a phone (the Capacitor app): the web view is resized by the keyboard itself, so the page must
// not pad by the keyboard's height again (it did, which squeezed a note to a line or two with an empty band under it).
// The shell's keyboard events can't run here, so this emulates what they leave behind: a viewport already shrunk to the
// space above the keyboard, html.keyboard-open, and the variables src/platform/capacitor.ts sets.
import { expect, test, type Page } from '@playwright/test';
import { api, createPage, createUser, openPage, signInContext } from './helpers.ts';

type J = Record<string, unknown>;
const p = (t: string): J => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });

async function openNote(page: Page, request: Parameters<typeof createPage>[0], user: Awaited<ReturnType<typeof createUser>>) {
  const { pageId: scratch, sectionId } = await createPage(request, user, { notebook: 'Phone', page: 'Scratch' });
  const lines = Array.from({ length: 14 }, (_, i) => p(`Line number ${i + 1} of the note`));
  const content = { type: 'doc', content: [{ type: 'canvasBox', attrs: { x: 0, y: 0, w: 520, z: 1, wide: true }, content: lines }] };
  await api(request, 'POST', `/pages/${scratch}/templates`, user.token, { name: 'Phone template', kind: 'canvas', content });
  const { id } = await api<{ id: string }>(request, 'POST', `/sections/${sectionId}/pages`, user.token, { title: 'Phone note' });
  await openPage(page, user.wsId, id);
  await page.getByTestId('user-templates').locator('.template-card', { hasText: 'Phone template' }).click();
  await expect(page.locator('.canvas-box:not(.is-ready)')).toHaveCount(1);
}

/** What the shell leaves behind when the keyboard opens: html.keyboard-open and its variables (the viewport is already shorter). */
async function keyboardOpens(page: Page, keyboardHeight: number, inset: number) {
  await page.evaluate(
    ([h, i]) => {
      const root = document.documentElement;
      root.style.setProperty('--keyboard-height', `${h}px`);
      root.style.setProperty('--keyboard-inset', `${i}px`);
      root.classList.add('keyboard-open');
    },
    [keyboardHeight, inset],
  );
}

test('with the web view already shrunk by the keyboard, the note keeps the space above it and the caret line is visible', async ({ page, context, request }) => {
  const user = await createUser(request, 'Kay Board');
  await signInContext(context, user);
  await openNote(page, request, user);

  // iPhone 13: 390×664 with the keyboard down; the keyboard (about 336px) shrinks the web view to about 330px.
  await page.setViewportSize({ width: 390, height: 330 });
  await keyboardOpens(page, 336, 0);
  await page.waitForTimeout(300);

  // No padding for a keyboard that is already out of the way: the page area fills the space under the top bar.
  expect(await page.locator('.main').evaluate((e) => getComputedStyle(e).paddingBottom)).toBe('0px');
  const area = await page.locator('.page-scroll').boundingBox();
  expect(area, 'the page scroller').not.toBeNull();
  expect(area!.height, 'most of the space above the keyboard is the note').toBeGreaterThan(330 - 48 - 60);
  expect(area!.y + area!.height).toBeGreaterThan(330 - 10); // down to the bottom of the (shrunk) web view

  // Tap a line near the bottom of the note and type: the text shows, inside the viewport, with the caret in it.
  const line = page.locator('.canvas-box p', { hasText: 'Line number 9 of the note' });
  await line.scrollIntoViewIfNeeded();
  await line.tap();
  await page.keyboard.press('End');
  await page.keyboard.type(' typed');
  const typed = page.locator('.canvas-box p', { hasText: 'Line number 9 of the note typed' });
  await expect(typed).toBeVisible();
  const box = await typed.boundingBox();
  expect(box!.y).toBeGreaterThan(48); // below the top bar
  expect(box!.y + box!.height).toBeLessThanOrEqual(330); // above the keyboard
  expect(await page.evaluate(() => document.activeElement?.closest('.canvas-box') !== null)).toBe(true);
  // The title and the other lines are still there, just scrolled.
  await expect(page.locator('.page-title')).toHaveCount(1);
  await expect(page.locator('.canvas-box p', { hasText: 'Line number 1 of the note' })).toHaveCount(1);
});

test('a web view the keyboard does not shrink still gets the room it needs, from --keyboard-inset', async ({ page, context, request }) => {
  const user = await createUser(request, 'Pad Ding');
  await signInContext(context, user);
  await openNote(page, request, user);
  // No resize: the viewport keeps its height, so the shell asks for the whole keyboard as padding.
  await keyboardOpens(page, 336, 336);
  expect(await page.locator('.main').evaluate((e) => getComputedStyle(e).paddingBottom)).toBe('336px');
  // The tab bar gives way to the keyboard either way.
  await expect(page.locator('.tabbar')).toBeHidden();
});
