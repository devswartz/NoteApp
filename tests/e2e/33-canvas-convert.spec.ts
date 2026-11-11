// Canvas pages, phase 3 (docs/PLAN_CANVAS.md): "New page" makes a canvas ("New document page"
// a document), pages convert both ways from the page menu, box moves undo with Ctrl+Z, and
// templates keep their kind.
import { expect, test, type Page } from '@playwright/test';
import { api, createPage, createUser, eventually, openPage, pageUrl, signInContext } from './helpers.ts';

async function openCanvas(page: Page, wsId: string, pageId: string) {
  await page.goto(pageUrl(wsId, pageId));
  await expect(page.getByTestId('canvas-surface')).toBeVisible();
  await expect(page.locator('.sync-live')).toBeVisible({ timeout: 15_000 });
}

const pos = (box: ReturnType<Page['locator']>) => box.evaluate((el: HTMLElement) => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top) }));

async function pageMenu(page: Page, item: string) {
  await page.getByRole('button', { name: 'Page options' }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

type TreePage = { id: string; kind: string; sectionId: string };
const treePages = async (request: Parameters<typeof api>[0], token: string, wsId: string) =>
  (await api<{ pages: TreePage[] }>(request, 'GET', `/workspaces/${wsId}/tree`, token)).pages;

test('"New page" makes a canvas, "New document page" a document; the tree shows which is which', async ({ page, context, request }) => {
  const user = await createUser(request, 'Nina New');
  const { pageId: firstId } = await createPage(request, user, { notebook: 'Kinds', page: 'First' });
  await signInContext(context, user);
  await openPage(page, user.wsId, firstId);

  const sections = page.getByRole('navigation', { name: 'Sidebar' }).getByRole('tree', { name: 'Sections' });
  await sections.getByText('General', { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New page', exact: true }).click();
  await expect(page).not.toHaveURL(new RegExp(firstId));
  await expect(page.getByTestId('canvas-surface')).toBeVisible();
  const canvasId = page.url().split('/p/')[1]!.split(/[?#]/)[0]!;
  await expect(page.locator('.template-picker')).toBeVisible(); // an empty canvas offers templates too

  await sections.getByText('General', { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New document page' }).click();
  await expect(page).not.toHaveURL(new RegExp(canvasId));
  await expect(page.locator('.ProseMirror')).toBeVisible();
  await expect(page.getByTestId('canvas-surface')).toHaveCount(0);
  const docId = page.url().split('/p/')[1]!.split(/[?#]/)[0]!;

  const pages = await treePages(request, user.token, user.wsId);
  expect(pages.find((p) => p.id === canvasId)?.kind).toBe('canvas');
  expect(pages.find((p) => p.id === docId)?.kind).toBe('document');
  await expect(page.getByRole('navigation', { name: 'Sidebar' }).getByRole('img', { name: 'Canvas page' })).toHaveCount(1);
});

test('convert a document to a canvas and back from the page menu; the text survives both ways', async ({ page, context, request }) => {
  const user = await createUser(request, 'Connor Convert');
  const { pageId } = await createPage(request, user, { notebook: 'Convert', page: 'Plan' });
  await signInContext(context, user);
  const editor = await openPage(page, user.wsId, pageId);
  await editor.click();
  await page.keyboard.type('First paragraph');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Second paragraph');
  await expect(page.locator('.save-saved')).toBeVisible({ timeout: 10_000 });

  await pageMenu(page, 'Convert to canvas');
  await expect(page.getByTestId('canvas-surface')).toBeVisible();
  const box = page.locator('.canvas-box');
  await expect(box).toHaveCount(1);
  await expect(box).toContainText('First paragraph');
  await expect(box).toContainText('Second paragraph');
  expect(await pos(box)).toEqual({ x: 0, y: 0 });
  await eventually(() => treePages(request, user.token, user.wsId), (ps) => ps.find((p) => p.id === pageId)?.kind === 'canvas', 'page is a canvas');

  // Another box to the right, then back to a document: joined in reading order.
  await page.getByTestId('canvas-surface').click({ position: { x: 900, y: 20 } });
  await expect(page.locator('.canvas-box .ProseMirror:focus')).toBeVisible();
  await page.keyboard.type('Side note');
  await expect(page.locator('.save-saved')).toBeVisible({ timeout: 10_000 });
  await pageMenu(page, 'Convert to document');
  await expect(page.getByTestId('canvas-surface')).toHaveCount(0);
  const doc = page.locator('.ProseMirror');
  await expect(doc).toContainText('Second paragraph');
  await expect(doc).toContainText('Side note');
  expect(await doc.innerText()).toMatch(/First paragraph[\s\S]*Second paragraph[\s\S]*Side note/);
  await eventually(() => treePages(request, user.token, user.wsId), (ps) => ps.find((p) => p.id === pageId)?.kind === 'document', 'page is a document again');
});

test('Ctrl+Z outside a box undoes a move (and Ctrl+Shift+Z redoes it)', async ({ page, context, request }) => {
  const user = await createUser(request, 'Una Undo');
  const { sectionId } = await createPage(request, user, { notebook: 'Undo' });
  const { id } = await api<{ id: string }>(request, 'POST', `/sections/${sectionId}/pages`, user.token, { title: 'Board', kind: 'canvas' });
  await signInContext(context, user);
  await openCanvas(page, user.wsId, id);

  await page.getByTestId('canvas-surface').click({ position: { x: 60, y: 60 } });
  await expect(page.locator('.canvas-box .ProseMirror:focus')).toBeVisible();
  await page.keyboard.type('Undo me');
  const box = page.locator('.canvas-box', { hasText: 'Undo me' });
  await page.keyboard.press('Escape'); // select the box (leave its text)
  await expect(box).toBeFocused();
  const start = await pos(box);

  await box.hover();
  const handle = (await box.locator('.canvas-box-move').boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 150, handle.y + handle.height / 2 + 100, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => pos(box)).toEqual({ x: start.x + 150, y: start.y + 100 });
  await expect(box).toBeFocused();

  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => pos(box)).toEqual(start);
  await expect(box).toContainText('Undo me'); // text untouched
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(() => pos(box)).toEqual({ x: start.x + 150, y: start.y + 100 });
});

test('templates keep their kind: a canvas saved as a template makes a canvas, even from an empty document page', async ({ page, context, request }) => {
  const user = await createUser(request, 'Tia Template');
  const { sectionId } = await createPage(request, user, { notebook: 'Templates' });
  const { id } = await api<{ id: string }>(request, 'POST', `/sections/${sectionId}/pages`, user.token, { title: 'Daily', kind: 'canvas' });
  await signInContext(context, user);
  await openCanvas(page, user.wsId, id);

  // The built-in daily journal, laid out as boxes.
  await page.locator('.template-card', { hasText: 'Daily journal' }).click();
  await expect(page.locator('.canvas-box')).toHaveCount(4);
  await expect(page.locator('.canvas-box', { hasText: 'Top 3 today' })).toBeVisible();
  await expect(page.locator('.template-picker')).toHaveCount(0);
  await expect(page.locator('.save-saved')).toBeVisible({ timeout: 10_000 });

  await pageMenu(page, 'Save as template…');
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox').first().fill('Board day');
  await dialog.getByRole('button', { name: 'Save template' }).click();
  await expect(page.getByText('Template saved for the workspace')).toBeVisible();
  const saved = await api<{ name: string; kind: string }[]>(request, 'GET', `/workspaces/${user.wsId}/templates`, user.token);
  expect(saved.map((t) => [t.name, t.kind])).toEqual([['Board day', 'canvas']]);

  // Used on an empty document page: the page becomes a canvas with the template's boxes.
  const { id: docId } = await api<{ id: string }>(request, 'POST', `/sections/${sectionId}/pages`, user.token, { title: '' });
  await openPage(page, user.wsId, docId);
  await page.getByTestId('user-templates').locator('.template-card', { hasText: 'Board day' }).click();
  await expect(page.getByTestId('canvas-surface')).toBeVisible();
  await expect(page.locator('.canvas-box')).toHaveCount(4);
  await expect(page.locator('.canvas-box', { hasText: 'Grateful for' })).toBeVisible();
  await eventually(() => treePages(request, user.token, user.wsId), (ps) => ps.find((p) => p.id === docId)?.kind === 'canvas', 'the page became a canvas');
});

test('version history on a canvas: the preview shows the boxes and Restore brings the whole canvas back', async ({ page, context, request }) => {
  const user = await createUser(request, 'Vera Version');
  const { sectionId } = await createPage(request, user, { notebook: 'History' });
  const { id } = await api<{ id: string }>(request, 'POST', `/sections/${sectionId}/pages`, user.token, { title: 'Board', kind: 'canvas' });
  await signInContext(context, user);
  await openCanvas(page, user.wsId, id);

  await page.getByTestId('canvas-surface').click({ position: { x: 60, y: 60 } });
  await expect(page.locator('.canvas-box .ProseMirror:focus')).toBeVisible();
  await page.keyboard.type('Original box');
  await page.getByTestId('canvas-surface').click({ position: { x: 700, y: 60 } });
  await expect(page.locator('.canvas-box')).toHaveCount(2);
  await expect(page.locator('.canvas-box').nth(1).locator('.ProseMirror:focus')).toBeVisible();
  await page.keyboard.type('Second box');
  await expect(page.locator('.save-saved')).toBeVisible({ timeout: 10_000 });
  await api(request, 'POST', `/pages/${id}/versions`, user.token, {});

  // Delete a box and rewrite the other.
  const second = page.locator('.canvas-box', { hasText: 'Second box' });
  await second.locator('.ProseMirror').click();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Delete');
  await expect(page.locator('.canvas-box')).toHaveCount(1);
  await page.locator('.canvas-box .ProseMirror').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Rewritten');
  await expect(page.locator('.save-saved')).toBeVisible({ timeout: 10_000 });

  await pageMenu(page, 'Version history');
  const history = page.getByRole('dialog', { name: 'Version history' });
  await history.locator('.history-item').last().click();
  await expect(history.locator('.history-box')).toHaveCount(2);
  await expect(history.locator('.history-doc')).toContainText('Original box');
  await history.getByRole('button', { name: 'Restore this version' }).click();
  await expect(history).toHaveCount(0);
  await expect(page.locator('.canvas-box')).toHaveCount(2);
  await expect(page.locator('.canvas-box', { hasText: 'Original box' })).toBeVisible();
  await expect(page.locator('.canvas-box', { hasText: 'Second box' })).toBeVisible();
});
