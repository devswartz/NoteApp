// Canvas-only pages (docs/PLAN_CANVAS.md): a blank page's first box is ready for typing and stored
// only once typed in, across the page's width; the outline and ?task= links reach into every box;
// box moves undo with Ctrl+Z; canvas templates and version history.
import { expect, test, type Page } from '@playwright/test';
import { api, createPage, createUser, eventually, listTasks, openPage, pageUrl, signInContext } from './helpers.ts';

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

test('a blank page: type at once into its first box, which is stored only then, across the page', async ({ page, context, request }) => {
  const user = await createUser(request, 'Bea Blank');
  const { pageId } = await createPage(request, user, { notebook: 'Blank', page: 'Fresh' });
  await signInContext(context, user);
  await openCanvas(page, user.wsId, pageId);

  // The first box is there and focused: just start typing. Nothing is stored yet.
  const ready = page.locator('.canvas-box.is-ready');
  await expect(ready.locator('.ProseMirror')).toBeFocused();
  await expect(page.locator('.template-picker')).toBeVisible();
  await page.reload();
  await expect(page.locator('.sync-live')).toBeVisible({ timeout: 15_000 });
  await expect(ready).toHaveCount(1); // still unstored: opening a page leaves it empty
  await expect(ready.locator('.ProseMirror')).toBeFocused();

  await page.keyboard.type('Hello canvas');
  const box = page.locator('.canvas-box.is-wide:not(.is-ready)');
  await expect(box).toHaveCount(1);
  await expect(box).toContainText('Hello canvas');
  await expect(page.locator('.template-picker')).toHaveCount(0);
  // Across the note area (OneNote-style), its text lined up with the title.
  const b = (await box.boundingBox())!;
  const area = (await page.locator('.page-scroll').boundingBox())!;
  expect(b.x - area.x).toBeLessThan(60);
  expect(area.x + area.width - (b.x + b.width)).toBeLessThan(60);
  const title = (await page.locator('.page-title').boundingBox())!;
  const text = (await box.locator('.ProseMirror p').first().boundingBox())!;
  expect(Math.abs(text.x - title.x)).toBeLessThanOrEqual(3);
  expect(await pos(box)).toEqual({ x: 0, y: 0 });

  // Saved: searchable, and still one wide box after a reload.
  await eventually(
    async () => (await api<{ pages: { id: string }[] }>(request, 'GET', `/workspaces/${user.wsId}/search?q=Hello`, user.token)).pages,
    (ps) => ps.some((p) => p.id === pageId),
    'the box text is saved',
  );
  await openCanvas(page, user.wsId, pageId);
  await expect(page.locator('.canvas-box')).toHaveCount(1);
  await expect(page.locator('.canvas-box.is-wide')).toContainText('Hello canvas');
  expect((await treePages(request, user.token, user.wsId)).find((p) => p.id === pageId)?.kind).toBe('canvas');

  // There is no kind to choose: one "New page", no convert items.
  const sections = page.getByRole('navigation', { name: 'Sidebar' }).getByRole('tree', { name: 'Sections' });
  await sections.getByText('General', { exact: true }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'New page', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /document/i })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Page options' }).click();
  await expect(page.getByRole('menuitem', { name: /Convert/ })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Version history' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /Full width/ })).toHaveCount(0); // always full width
});

test.describe('across boxes', () => {
  test.use({ viewport: { width: 1800, height: 900 } });

  test('the outline lists the headings of every box in reading order and jumps into the right box', async ({ page, context, request }) => {
    const user = await createUser(request, 'Otto Outline');
    const { pageId } = await createPage(request, user, { notebook: 'Outlines', page: 'Two boxes' });
    await signInContext(context, user);
    await openCanvas(page, user.wsId, pageId);
    await expect(page.locator('.canvas-box.is-ready .ProseMirror')).toBeFocused();
    await page.keyboard.type('## Alpha', { delay: 20 });
    await page.keyboard.press('Enter');
    await page.keyboard.type('## Beta', { delay: 20 });
    await page.getByTestId('canvas-surface').click({ position: { x: 60, y: 260 } });
    await expect(page.locator('.canvas-box')).toHaveCount(2);
    const second = page.locator('.canvas-box').nth(1);
    await expect(second.locator('.ProseMirror')).toBeFocused();
    await page.keyboard.type('## Gamma', { delay: 20 });
    await page.keyboard.press('Enter');
    await page.keyboard.type('## Delta', { delay: 20 });

    const nav = page.getByRole('navigation', { name: 'On this page' });
    await expect(nav.getByRole('button')).toHaveText(['Alpha', 'Beta', 'Gamma', 'Delta']);
    await page.locator('.canvas-box').first().locator('.ProseMirror').click();
    await nav.getByRole('button', { name: 'Gamma' }).click();
    await expect(second.locator('.ProseMirror')).toBeFocused();
    await page.keyboard.type('!');
    await expect(second.locator('h2').first()).toHaveText('!Gamma');
    await expect(nav.getByRole('button')).toHaveText(['Alpha', 'Beta', '!Gamma', 'Delta']);
  });

  test('a ?task= link finds a task in a second box, below a long first one', async ({ page, context, request }) => {
    const user = await createUser(request, 'Tess Taskbox');
    const { pageId } = await createPage(request, user, { notebook: 'Links', page: 'Long and boxed' });
    await signInContext(context, user);
    await openCanvas(page, user.wsId, pageId);
    const first = page.locator('.canvas-box.is-ready .ProseMirror');
    await expect(first).toBeFocused();
    await page.evaluate(() => {
      let html = '';
      for (let i = 0; i < 60; i++) html += `<p>${`Line ${i} of a long first box. `.repeat(5)}</p>`;
      const dt = new DataTransfer();
      dt.setData('text/html', html);
      dt.setData('text/plain', 'long');
      document.querySelector('.canvas-box .ProseMirror')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await expect(page.locator('.canvas-box:not(.is-ready)')).toHaveCount(1);
    await expect(page.locator('.save-saved')).toBeVisible({ timeout: 10_000 });

    // With no box in use, "Add a task to this page" starts a new box under the others.
    await openCanvas(page, user.wsId, pageId);
    await page.getByRole('button', { name: 'Add a task to this page' }).click();
    const input = page.locator('.task-ref-title:focus');
    await input.fill('Boxed task');
    await input.press('Enter');
    await expect(page.locator('.canvas-box')).toHaveCount(2);
    const ref = page.locator('.canvas-box').nth(1).locator('.task-ref', { has: page.locator('.task-ref-title[data-value="Boxed task"]') });
    await expect(ref).toHaveCount(1);
    const taskId = (await ref.getAttribute('data-task-id'))!;
    await eventually(() => listTasks(request, user), (ts) => ts.some((t) => t.id === taskId && t.pageId === pageId), 'task saved on the page');
    await page.waitForTimeout(1500); // the server persists the doc 1 s after the last edit

    await page.goto(`${pageUrl(user.wsId, pageId)}?task=${taskId}`);
    const target = page.locator(`.task-ref[data-task-id="${taskId}"]`);
    await expect(target).toBeInViewport({ timeout: 10_000 });
    await expect(page).not.toHaveURL(/task=/);
  });
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

test('a canvas saved as a template keeps its boxes, and using it on a blank page lays them out again', async ({ page, context, request }) => {
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

  // Used on another blank page: the template's boxes.
  const { id: docId } = await api<{ id: string }>(request, 'POST', `/sections/${sectionId}/pages`, user.token, { title: '' });
  await openPage(page, user.wsId, docId);
  await page.getByTestId('user-templates').locator('.template-card', { hasText: 'Board day' }).click();
  await expect(page.getByTestId('canvas-surface')).toBeVisible();
  await expect(page.locator('.canvas-box')).toHaveCount(4);
  await expect(page.locator('.canvas-box', { hasText: 'Grateful for' })).toBeVisible();
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
