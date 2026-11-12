// Picking separate lines (Ctrl/Cmd+click, Ctrl/Cmd+drag) inside and across boxes, "Print selection" printing exactly
// them, the right-click menu, and a selection from an untitled page printing without a title.
// Set E2E_SHOTS=<dir> to also save screenshots.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { api, createPage, createUser, openPage, ribbon, signInContext, type TestUser } from './helpers.ts';

type J = Record<string, unknown>;
const text = (t: string, marks?: J[]): J => ({ type: 'text', text: t, ...(marks ? { marks } : {}) });
const p = (...c: J[]): J => ({ type: 'paragraph', content: c });
const box = (x: number, y: number, w: number, content: J[]): J => ({ type: 'canvasBox', attrs: { x, y, w, z: 1 }, content });

async function stubPrint(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __printed: number }).__printed = 0;
    window.print = () => {
      (window as unknown as { __printed: number }).__printed++;
    };
  });
}
const printed = (page: Page) => page.evaluate(() => (window as unknown as { __printed: number }).__printed);
const shot = async (page: Page, name: string) => {
  if (process.env.E2E_SHOTS) {
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${process.env.E2E_SHOTS}/${name}.png` });
  }
};

/** A canvas page with these boxes (made through a template). `pageTitle` '' makes an untitled page. */
async function canvasPage(request: APIRequestContext, page: Page, user: TestUser, pageTitle: string, boxes: J[]) {
  const { pageId: scratch, sectionId } = await createPage(request, user, { notebook: 'Picks', page: 'Scratch' });
  await api(request, 'POST', `/pages/${scratch}/templates`, user.token, { name: 'Picks template', kind: 'canvas', content: { type: 'doc', content: boxes } });
  const { id: pageId } = await api<{ id: string }>(request, 'POST', `/sections/${sectionId}/pages`, user.token, { title: pageTitle });
  await openPage(page, user.wsId, pageId);
  await page.getByTestId('user-templates').locator('.template-card', { hasText: 'Picks template' }).click();
  await expect(page.locator('.canvas-box:not(.is-ready)')).toHaveCount(boxes.length);
  // Applying a template names an untitled page after it: an untitled page is one whose title is cleared.
  if (!pageTitle) {
    await page.locator('.page-title').fill('');
    await expect(page.locator('.page-title')).toHaveValue('');
    await page.waitForTimeout(1500); // the new title reaches the page list
  }
  return pageId;
}

const CTRL = ['ControlOrMeta' as const];
const line = (page: Page, t: string) => page.locator('.canvas-box p', { hasText: new RegExp(`^${t}$`) });
const picked = (page: Page) => page.locator('.canvas-box .is-line-picked');
const printButton = (page: Page) => ribbon(page).getByRole('button', { name: 'Print selection', exact: true });

const twoBoxes = [
  box(0, 0, 500, [p(text('Alpha')), p(text('Bravo')), p(text('Charlie')), p(text('Delta'))]),
  box(0, 400, 500, [p(text('Echo')), p(text('Foxtrot'))]),
];

test('Ctrl+click picks separate lines in and across boxes; Print selection prints only those, under a small title', async ({ page, context, request }) => {
  const user = await createUser(request, 'Lina Lines');
  await signInContext(context, user);
  await stubPrint(page);
  await canvasPage(request, page, user, 'Field notes', twoBoxes);

  await line(page, 'Bravo').click({ modifiers: CTRL });
  await line(page, 'Delta').click({ modifiers: CTRL });
  await line(page, 'Foxtrot').click({ modifiers: CTRL });
  await expect(picked(page)).toHaveCount(3);
  await expect(picked(page)).toHaveText(['Bravo', 'Delta', 'Foxtrot']);
  await expect(page.locator('.canvas-box.is-picked')).toHaveCount(0); // lines, not whole boxes
  await shot(page, 'lines-picked');

  // Ctrl+click on a picked line takes it out; once more puts it back.
  await line(page, 'Bravo').click({ modifiers: CTRL });
  await expect(picked(page)).toHaveCount(2);
  await line(page, 'Bravo').click({ modifiers: CTRL });
  await expect(picked(page)).toHaveCount(3);

  await printButton(page).click();
  await expect.poll(() => printed(page)).toBe(1);
  await page.emulateMedia({ media: 'print' });
  const root = page.locator('#print-root');
  await expect(root.locator('.print-title')).toHaveText('Field notes');
  await expect(root.locator('.print-title')).toHaveClass(/is-small/);
  await expect(root.locator('.print-box')).toHaveText([/^\s*Bravo\s*Delta\s*$/, /^\s*Foxtrot\s*$/]);
  for (const gone of ['Alpha', 'Charlie', 'Echo']) await expect(root).not.toContainText(gone);

  // Escape clears the picks.
  await page.emulateMedia({ media: 'screen' });
  await page.keyboard.press('Escape');
  await expect(picked(page)).toHaveCount(0);
  await expect(printButton(page)).toHaveCount(0);

  // A plain click clears them too.
  await line(page, 'Echo').click({ modifiers: CTRL });
  await expect(picked(page)).toHaveCount(1);
  await line(page, 'Alpha').click();
  await expect(picked(page)).toHaveCount(0);
});

test('Ctrl+click on a box frame still picks the whole box; Ctrl+drag picks every line it sweeps', async ({ page, context, request }) => {
  const user = await createUser(request, 'Dana Drag');
  await signInContext(context, user);
  await stubPrint(page);
  await canvasPage(request, page, user, 'Sweep', twoBoxes);

  // The frame: the box's left padding, outside its text.
  await page.locator('.canvas-box', { hasText: 'Echo' }).click({ modifiers: CTRL, position: { x: 4, y: 12 } });
  await expect(page.locator('.canvas-box.is-picked')).toHaveCount(1);
  await expect(picked(page)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('.canvas-box.is-picked')).toHaveCount(0);

  // Ctrl+drag from Alpha down to Charlie.
  const from = await line(page, 'Alpha').boundingBox();
  const to = await line(page, 'Charlie').boundingBox();
  if (!from || !to) throw new Error('lines not found');
  await page.keyboard.down('Control');
  await page.mouse.move(from.x + 40, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + 40, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up('Control');
  await expect(picked(page)).toHaveText(['Alpha', 'Bravo', 'Charlie']);
});

test('right-click on picked lines or a selection: Print selection; elsewhere the browser keeps its own menu', async ({ page, context, request }) => {
  const user = await createUser(request, 'Rory Rightclick');
  await signInContext(context, user);
  await stubPrint(page);
  await canvasPage(request, page, user, 'Menus', twoBoxes);
  const item = page.getByRole('menuitem', { name: 'Print selection' });

  // Not on a selection: no menu of ours (the browser's own, with spelling suggestions, opens instead).
  await line(page, 'Charlie').click({ button: 'right' });
  await expect(item).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Picked lines: right-click one.
  await line(page, 'Bravo').click({ modifiers: CTRL });
  await line(page, 'Delta').click({ modifiers: CTRL });
  await line(page, 'Delta').click({ button: 'right' });
  await expect(item).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Copy' })).toBeVisible();
  await shot(page, 'selection-menu');
  await item.click();
  await expect.poll(() => printed(page)).toBe(1);
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('#print-root .print-box')).toHaveText([/^\s*Bravo\s*Delta\s*$/]);
  await page.emulateMedia({ media: 'screen' });
  await page.keyboard.press('Escape');
  await expect(picked(page)).toHaveCount(0);

  // A single selected word keeps the browser's menu (so a misspelling can still be corrected).
  await line(page, 'Charlie').dblclick();
  await line(page, 'Charlie').click({ button: 'right' });
  await expect(item).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Selected text of several words or lines: right-click inside it.
  await line(page, 'Alpha').click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+End');
  await expect(printButton(page)).toBeVisible(); // the editor has taken in the selection
  await line(page, 'Bravo').click({ button: 'right', position: { x: 20, y: 8 } });
  await expect(item).toBeVisible();
  await item.click();
  await expect.poll(() => printed(page)).toBe(2);
});

test('a selection from an untitled page prints without a title; a titled one keeps a small title', async ({ page, context, request }) => {
  const user = await createUser(request, 'Una Titled');
  await signInContext(context, user);
  await stubPrint(page);
  await canvasPage(request, page, user, '', twoBoxes);

  await line(page, 'Echo').click({ modifiers: CTRL });
  await printButton(page).click();
  await expect.poll(() => printed(page)).toBe(1);
  await page.emulateMedia({ media: 'print' });
  const root = page.locator('#print-root');
  await expect(root.locator('.print-box')).toHaveText([/^\s*Echo\s*$/]);
  await expect(root.locator('.print-title')).toHaveCount(0);
  await expect(root).not.toContainText('Untitled');
});
