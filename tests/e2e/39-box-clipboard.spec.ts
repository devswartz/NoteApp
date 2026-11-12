// Copy, cut, paste and duplicate of whole canvas boxes: click a box's top edge to select it, then Ctrl+C / X / V;
// right-click the top edge for the box's options and empty canvas for Paste.
// Set E2E_SHOTS=<dir> to also save screenshots.
import { expect, test, type Page } from '@playwright/test';
import { api, createPage, createUser, pageUrl, signInContext } from './helpers.ts';

const shot = async (page: Page, name: string) => {
  if (process.env.E2E_SHOTS) await page.waitForTimeout(350); // let menus and transitions settle
  if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/${name}.png` });
};

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
}

/** Let the editor take in the last key (it learns of a selection change a frame later). */
const settle = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

const boxes = (page: Page, text: string) => page.locator('.canvas-box', { hasText: text });
const pos = (box: ReturnType<Page['locator']>) => box.evaluate((el: HTMLElement) => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top) }));

/** A plain click (no drag) on a box's top edge. */
async function clickEdge(page: Page, box: ReturnType<Page['locator']>, button: 'left' | 'right' = 'left') {
  await box.hover();
  const h = await box.locator('.canvas-box-move').boundingBox();
  if (!h) throw new Error('no move handle');
  await page.mouse.click(h.x + h.width / 2, h.y + h.height / 2, { button });
}

test('click a box edge to select it, copy and paste it; right-click for options; cut and paste at the click; undo', async ({ page, context, request }) => {
  const user = await createUser(request, 'Clip Boarder');
  const { sectionId } = await createPage(request, user, { notebook: 'Clips' });
  const { id } = await api<{ id: string }>(request, 'POST', `/sections/${sectionId}/pages`, user.token, { title: 'Clips', kind: 'canvas' });
  await signInContext(context, user);
  await openCanvas(page, user.wsId, id);
  const all = page.locator('.canvas-box:not(.is-ready)');

  await newBox(page, 40, 240, 'Alpha');
  await newBox(page, 40, 440, 'Beta');
  await expect(all).toHaveCount(2);

  // A click on the top edge selects the box (and leaves its text alone).
  await clickEdge(page, boxes(page, 'Alpha'));
  await expect(boxes(page, 'Alpha')).toHaveClass(/is-picked/);
  await expect(boxes(page, 'Beta')).not.toHaveClass(/is-picked/);
  await shot(page, 'box-selected');

  // Ctrl+C, Ctrl+V: a copy lands a little down and right of the original, and is selected.
  const at = await pos(boxes(page, 'Alpha'));
  await page.keyboard.press('ControlOrMeta+c');
  await page.keyboard.press('ControlOrMeta+v');
  await expect(boxes(page, 'Alpha')).toHaveCount(2);
  const spots = await boxes(page, 'Alpha').evaluateAll((els) => els.map((el) => ({ x: parseFloat((el as HTMLElement).style.left), y: parseFloat((el as HTMLElement).style.top) })));
  expect(spots.some((s) => s.x === at.x + 24 && s.y >= at.y + 24)).toBe(true);

  // Ctrl+Z takes the paste back as one step.
  await page.keyboard.press('ControlOrMeta+z');
  await expect(boxes(page, 'Alpha')).toHaveCount(1);

  // Right-click the top edge: the box's options. Duplicate adds a copy.
  await clickEdge(page, boxes(page, 'Beta'), 'right');
  await shot(page, 'box-menu');
  await page.getByRole('menuitem', { name: 'Duplicate' }).click();
  await expect(boxes(page, 'Beta')).toHaveCount(2);

  // Cut Alpha from its menu, then paste it where empty canvas is right-clicked.
  await clickEdge(page, boxes(page, 'Alpha'), 'right');
  await page.getByRole('menuitem', { name: /^Cut/ }).click();
  await expect(boxes(page, 'Alpha')).toHaveCount(0);
  await page.getByTestId('canvas-surface').click({ button: 'right', position: { x: 700, y: 420 } });
  await shot(page, 'canvas-menu');
  await page.getByRole('menuitem', { name: /^Paste/ }).click();
  await expect(boxes(page, 'Alpha')).toHaveCount(1);
  const pasted = await pos(boxes(page, 'Alpha'));
  expect(Math.abs(pasted.x - 700)).toBeLessThan(2);
  expect(Math.abs(pasted.y - 420)).toBeLessThan(40); // the rule grid may snap it

  // Delete from the menu.
  await clickEdge(page, boxes(page, 'Alpha'), 'right');
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(boxes(page, 'Alpha')).toHaveCount(0);

  // It all persists.
  await page.waitForTimeout(1500);
  await page.reload();
  await expect(page.locator('.sync-live')).toBeVisible({ timeout: 15_000 });
  await expect(boxes(page, 'Beta')).toHaveCount(2);
  await expect(boxes(page, 'Alpha')).toHaveCount(0);
});

test('with the caret in a box, Ctrl+C and Ctrl+V still work on text, not boxes', async ({ page, context, request }) => {
  const user = await createUser(request, 'Text Copier');
  const { sectionId } = await createPage(request, user, { notebook: 'Texts' });
  const { id } = await api<{ id: string }>(request, 'POST', `/sections/${sectionId}/pages`, user.token, { title: 'Texts', kind: 'canvas' });
  await signInContext(context, user);
  await openCanvas(page, user.wsId, id);
  await newBox(page, 40, 240, 'Hello');
  await page.keyboard.press('ControlOrMeta+a');
  await settle(page);
  await page.keyboard.press('ControlOrMeta+c');
  await settle(page);
  await page.keyboard.press('End');
  await settle(page);
  await page.keyboard.press('ControlOrMeta+v');
  await expect(page.locator('.canvas-box:not(.is-ready)')).toHaveCount(1);
  await expect(page.locator('.canvas-box .ProseMirror').first()).toContainText('HelloHello');
});
