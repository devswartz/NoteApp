// Canvas pages, phase 2 (docs/PLAN_CANVAS.md): the desktop canvas editor. Click anywhere
// to start a text box, type, move it by its top edge; positions and text persist, another
// user sees boxes move live, and an inline task in a box is a real task.
import { expect, test, type Browser, type Page } from '@playwright/test';
import { api, createPage, createTeam, createUser, eventually, listTasks, pageUrl, railTo, ribbon, signInContext, taskRow, type TestUser } from './helpers.ts';

async function userPage(browser: Browser, user: TestUser) {
  const context = await browser.newContext();
  await signInContext(context, user);
  return { context, page: await context.newPage() };
}

async function openCanvas(page: Page, wsId: string, pageId: string) {
  await page.goto(pageUrl(wsId, pageId));
  await expect(page.getByTestId('canvas-surface')).toBeVisible();
  await expect(page.locator('.sync-live')).toBeVisible({ timeout: 15_000 });
}

/** Click empty canvas space at (x, y) and type into the new box (a blank page's ready first box isn't counted: it isn't stored). */
async function newBox(page: Page, x: number, y: number, text: string) {
  const stored = page.locator('.canvas-box:not(.is-ready)');
  const before = await stored.count();
  await page.getByTestId('canvas-surface').click({ position: { x, y } });
  await expect(stored).toHaveCount(before + 1);
  // The new (empty) box has the caret, not the one typed in before (mousedown keeps focus until it mounts).
  await expect(page.locator('.canvas-box .ProseMirror:focus')).toHaveText('');
  await page.keyboard.type(text);
  return page.locator('.canvas-box', { hasText: text });
}

const pos = (box: ReturnType<Page['locator']>) => box.evaluate((el: HTMLElement) => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top) }));

/** Drag a box by its top edge. */
async function dragBox(page: Page, box: ReturnType<Page['locator']>, dx: number, dy: number) {
  await box.hover();
  const handle = await box.locator('.canvas-box-move').boundingBox();
  if (!handle) throw new Error('no move handle');
  const sx = handle.x + handle.width / 2;
  const sy = handle.y + handle.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + dx / 2, sy + dy / 2, { steps: 4 });
  await page.mouse.move(sx + dx, sy + dy, { steps: 4 });
  await page.mouse.up();
}

test('canvas page: click to make boxes, type, move one; it all persists; a task in a box is a real task', async ({ page, context, request }) => {
  const user = await createUser(request, 'Cara Canvas');
  const { pageId: docId } = await createPage(request, user, { notebook: 'Boards', page: 'A document' });
  await signInContext(context, user);
  await page.goto(pageUrl(user.wsId, docId));
  await expect(page.locator('.sync-live')).toBeVisible({ timeout: 15_000 });

  // "New page" from the section's menu (every page is a canvas).
  const sidebarTree = page.getByRole('navigation', { name: 'Sidebar' }).getByRole('tree', { name: 'Sections' });
  await sidebarTree.getByText('General', { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New page', exact: true }).click();
  await expect(page).not.toHaveURL(new RegExp(docId));
  const canvasId = page.url().split('/p/')[1]!.split(/[?#]/)[0]!;
  await openCanvas(page, user.wsId, canvasId);
  await page.locator('.page-title').fill('Whiteboard');

  const first = await newBox(page, 40, 240, 'Left box'); // below the blank page's ready first box and its template picker
  const second = await newBox(page, 520, 40, 'Right box');
  await expect(page.locator('.canvas-box')).toHaveCount(2);
  const start = await pos(first);

  await dragBox(page, first, 30, 220);
  await expect.poll(() => pos(first)).toEqual({ x: start.x + 30, y: start.y + 220 });
  const moved = await pos(first);
  const right = await pos(second);

  // An inline task in the right box.
  await second.locator('.ProseMirror').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/task');
  await expect(page.locator('.slash-menu .slash-title').first()).toHaveText('Task');
  await page.keyboard.press('Enter');
  const input = page.locator('.task-ref-title:focus');
  await expect(input).toBeVisible();
  await input.fill('Sketch the layout');
  await input.press('Enter');
  await page.keyboard.press('Enter'); // leave task mode
  await expect(second.locator('.task-ref')).toHaveCount(1);
  await eventually(
    () => listTasks(request, user),
    (ts) => ts.some((t) => t.title === 'Sketch the layout' && t.pageId === canvasId),
    'task in a canvas box linked to its page',
  );

  // Reload: positions and text are kept.
  await expect(page.locator('.save-saved')).toBeVisible({ timeout: 10_000 });
  await openCanvas(page, user.wsId, canvasId);
  await expect(page.locator('.canvas-box')).toHaveCount(2);
  const left = page.locator('.canvas-box', { hasText: 'Left box' });
  const rightBox = page.locator('.canvas-box', { hasText: 'Right box' });
  await expect(left).toBeVisible();
  await expect(rightBox).toBeVisible();
  expect(await pos(left)).toEqual(moved);
  expect(await pos(rightBox)).toEqual(right);
  await expect(rightBox.locator('.task-ref')).toHaveCount(1);

  // The task is in My Tasks.
  await railTo(page, 'Tasks');
  await page.getByRole('link', { name: 'My Tasks' }).click();
  await expect(taskRow(page, 'Sketch the layout')).toBeVisible();
});

test('canvas page: an empty box goes away; Escape selects a box and Delete removes it', async ({ page, context, request }) => {
  const user = await createUser(request, 'Kai Keys');
  const { sectionId } = await createPage(request, user, { notebook: 'Keys' });
  const { id } = await api<{ id: string }>(request, 'POST', `/sections/${sectionId}/pages`, user.token, { title: 'Keys', kind: 'canvas' });
  await signInContext(context, user);
  await openCanvas(page, user.wsId, id);

  await newBox(page, 40, 240, 'Keep me'); // below the blank page's template picker
  // A box left empty disappears when you click elsewhere.
  await page.getByTestId('canvas-surface').click({ position: { x: 600, y: 60 } });
  await expect(page.locator('.canvas-box')).toHaveCount(2);
  await page.getByTestId('canvas-surface').click({ position: { x: 600, y: 300 } });
  await expect(page.locator('.canvas-box')).toHaveCount(2); // the first empty one went, a new empty one came
  await page.locator('.canvas-box', { hasText: 'Keep me' }).locator('.ProseMirror').click();
  await expect(page.locator('.canvas-box')).toHaveCount(1);

  const next = await newBox(page, 40, 360, 'Below it');

  // Escape selects the box; arrows nudge it; Tab / Shift+Tab go through boxes in reading order; Delete removes it.
  const box = page.locator('.canvas-box', { hasText: 'Keep me' });
  await box.locator('.ProseMirror').click();
  const at = await pos(box);
  await page.keyboard.press('Escape');
  await expect(box).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => pos(box)).toEqual({ x: at.x + 10, y: at.y });
  await page.keyboard.press('Tab');
  await expect(next).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(box).toBeFocused();
  await page.keyboard.press('Delete');
  await expect(page.locator('.canvas-box')).toHaveCount(1);
  await expect(next).toBeVisible();
});

test('canvas page: undo / redo take back the latest change, a box move or typing, wherever focus is', async ({ page, context, request }) => {
  const user = await createUser(request, 'Uma Undo');
  const { sectionId } = await createPage(request, user, { notebook: 'Undo' });
  const { id } = await api<{ id: string }>(request, 'POST', `/sections/${sectionId}/pages`, user.token, { title: 'Undo', kind: 'canvas' });
  await signInContext(context, user);
  await openCanvas(page, user.wsId, id);
  const undoBtn = ribbon(page).getByRole('button', { name: /^Undo/ });
  const redoBtn = ribbon(page).getByRole('button', { name: /^Redo/ });

  const box = await newBox(page, 40, 240, 'Undo me');
  const text = box.locator('.ProseMirror');
  const start = await pos(box);
  await page.waitForTimeout(600); // the typing is its own undo step

  // Move the box while typing in it: focus stays in its text.
  await dragBox(page, box, 120, 80);
  const moved = { x: start.x + 120, y: start.y + 80 };
  await expect.poll(() => pos(box)).toEqual(moved);
  await expect(text).toBeFocused();

  // Ctrl+Z (in the text) undoes the move, not the typing; Ctrl+Y / Ctrl+Shift+Z redo it.
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => pos(box)).toEqual(start);
  await expect(text).toHaveText('Undo me');
  await page.keyboard.press('ControlOrMeta+y');
  await expect.poll(() => pos(box)).toEqual(moved);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => pos(box)).toEqual(start);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(() => pos(box)).toEqual(moved);

  // The ribbon's Undo / Redo do the same.
  await expect(undoBtn).not.toHaveAttribute('aria-disabled', 'true');
  await expect(redoBtn).toHaveAttribute('aria-disabled', 'true');
  await undoBtn.click();
  await expect.poll(() => pos(box)).toEqual(start);
  await expect(text).toHaveText('Undo me');
  await expect(redoBtn).not.toHaveAttribute('aria-disabled', 'true');
  await redoBtn.click();
  await expect.poll(() => pos(box)).toEqual(moved);

  // Text still undoes as text, and the box stays put.
  await text.press('End');
  await page.keyboard.type(' and more');
  await expect(text).toHaveText('Undo me and more');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(text).toHaveText('Undo me');
  expect(await pos(box)).toEqual(moved);
  await undoBtn.click(); // then the move before it
  await expect.poll(() => pos(box)).toEqual(start);
  await expect(text).toHaveText('Undo me');

  // Moving a paragraph within the box (Alt+Shift+↑) undoes from the keyboard and the ribbon.
  await text.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Second line');
  await page.waitForTimeout(600);
  const paras = text.locator('p');
  await page.keyboard.press('Alt+Shift+ArrowUp');
  await expect(paras.first()).toHaveText('Second line');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(paras.first()).toHaveText('Undo me');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(paras.first()).toHaveText('Second line');
  await undoBtn.click();
  await expect(paras.first()).toHaveText('Undo me');

  // With the box selected (not its text), Ctrl+Z still walks back the page's changes.
  await dragBox(page, box, 60, 0);
  await expect.poll(() => pos(box)).toEqual({ x: start.x + 60, y: start.y });
  await page.keyboard.press('Escape');
  await expect(box).toBeFocused();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => pos(box)).toEqual(start);
});

test('canvas page: a second user sees a box appear and move live', async ({ browser, request }) => {
  const alice = await createUser(request, 'Alice Arrange');
  const bob = await createUser(request, 'Bob Board');
  const teamId = await createTeam(request, alice, [{ user: bob, role: 'member' }]);
  const { sectionId } = await createPage(request, alice, { wsId: teamId, notebook: 'Team board' });
  const { id } = await api<{ id: string }>(request, 'POST', `/sections/${sectionId}/pages`, alice.token, { title: 'Board', kind: 'canvas' });

  const a = await userPage(browser, alice);
  const b = await userPage(browser, bob);
  await openCanvas(a.page, teamId, id);
  await openCanvas(b.page, teamId, id);

  const mine = await newBox(a.page, 60, 60, 'Moving note');
  const theirs = b.page.locator('.canvas-box', { hasText: 'Moving note' });
  await expect(theirs).toBeVisible();
  expect(await pos(theirs)).toEqual(await pos(mine));

  await dragBox(a.page, mine, 200, 120);
  const after = await pos(mine);
  await expect.poll(() => pos(theirs)).toEqual(after);

  await a.context.close();
  await b.context.close();
});
