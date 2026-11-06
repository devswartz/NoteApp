// Editor block behaviour beyond insertion: code languages, callout icons, toggle content,
// table rows/columns, file cards and pasted links. Each test reloads to prove it persisted.
// Owner: Editor & Notes (agent 2), coordinated with QA (docs/QA.md).
import { test, expect, type Page } from '@playwright/test';
import { createPage, createUser, focusEnd, openPage, signInContext } from './helpers.ts';

async function slash(page: Page, query: string) {
  await page.keyboard.type('/' + query);
  await expect(page.locator('.slash-menu .slash-item').first()).toBeVisible();
  await page.keyboard.press('Enter');
}

/** Cursor on an empty line at the end (there's always a trailing paragraph). */
async function nextLine(page: Page) {
  const last = page.locator('.ProseMirror > p').last();
  await last.click();
  await page.keyboard.press('End');
  if ((await last.textContent())?.trim()) await page.keyboard.press('Enter');
}

async function reload(page: Page) {
  await page.waitForTimeout(1500); // the collab server saves 1 s after the last edit
  await page.reload();
  await expect(page.locator('.sync-live')).toBeVisible({ timeout: 15_000 });
}

test.describe('editor blocks', () => {
  test('code blocks: pick a language, highlighting follows it, and it persists', async ({ page, context, request }) => {
    const user = await createUser(request, 'Code Lang');
    const { pageId } = await createPage(request, user, { page: 'Code' });
    await signInContext(context, user);
    const editor = await openPage(page, user.wsId, pageId);
    await focusEnd(page);
    await slash(page, 'code');
    await page.keyboard.type('def greet(name):\n    return f"hi {name}"');
    const block = editor.locator('.code-block');
    await block.getByRole('combobox', { name: 'Code language' }).selectOption('python');
    await expect(block.locator('.hljs-keyword').first()).toHaveText('def');
    await block.getByRole('combobox', { name: 'Code language' }).selectOption('plaintext');
    await expect(block.locator('.hljs-keyword')).toHaveCount(0); // plain text: no highlighting
    await block.getByRole('combobox', { name: 'Code language' }).selectOption('python');
    await reload(page);
    await expect(editor.locator('.code-block').getByRole('combobox', { name: 'Code language' })).toHaveValue('python');
    await expect(editor.locator('.code-block .hljs-keyword').first()).toHaveText('def');
  });

  test('callouts: change the icon, type inside, and it persists', async ({ page, context, request }) => {
    const user = await createUser(request, 'Call Out');
    const { pageId } = await createPage(request, user, { page: 'Callouts' });
    await signInContext(context, user);
    const editor = await openPage(page, user.wsId, pageId);
    await focusEnd(page);
    await slash(page, 'callout');
    await page.keyboard.type('Heads up');
    const callout = editor.locator('.callout');
    await callout.locator('.callout-emoji').click();
    await page.locator('.emoji-grid .emoji-btn', { hasText: '⚠️' }).click();
    await expect(callout.locator('.callout-emoji')).toHaveText('⚠️');
    await reload(page);
    await expect(editor.locator('.callout .callout-emoji')).toHaveText('⚠️');
    await expect(editor.locator('.callout .callout-body')).toHaveText('Heads up');
  });

  test('toggles: content inside the toggle is hidden when collapsed and kept after reload', async ({ page, context, request }) => {
    const user = await createUser(request, 'Tog Gle');
    const { pageId } = await createPage(request, user, { page: 'Toggles' });
    await signInContext(context, user);
    const editor = await openPage(page, user.wsId, pageId);
    await focusEnd(page);
    await slash(page, 'toggle');
    await page.keyboard.type('Details');
    await page.keyboard.press('Enter'); // into the toggle's content
    await page.keyboard.type('Hidden detail');
    const toggle = editor.locator('.toggle');
    await expect(toggle.getByText('Hidden detail')).toBeVisible();
    await toggle.locator('> button').click();
    await expect(toggle.getByText('Hidden detail')).toBeHidden();
    await reload(page);
    const after = editor.locator('.toggle');
    await expect(after.locator('summary, [data-type="detailsSummary"]').first()).toHaveText('Details');
    await after.locator('> button').click();
    await expect(after.getByText('Hidden detail')).toBeVisible();
  });

  test('tables: add and remove rows and columns from the table bar', async ({ page, context, request }) => {
    const user = await createUser(request, 'Ta Ble');
    const { pageId } = await createPage(request, user, { page: 'Tables' });
    await signInContext(context, user);
    const editor = await openPage(page, user.wsId, pageId);
    await focusEnd(page);
    await slash(page, 'table');
    const rows = editor.locator('table tr');
    const cols = editor.locator('table tr').first().locator('th, td');
    await expect(rows).toHaveCount(3);
    await expect(cols).toHaveCount(3);
    const bar = page.locator('.table-bar');
    await bar.locator('button[title="Add row below"]').click();
    await bar.locator('button[title="Add column right"]').click();
    await expect(rows).toHaveCount(4);
    await expect(cols).toHaveCount(4);
    await page.keyboard.type('new cell');
    await bar.locator('button[title="Delete column"]').click();
    await expect(cols).toHaveCount(3);
    await bar.locator('button[title="Delete row"]').click();
    await expect(rows).toHaveCount(3);
    await reload(page);
    await expect(editor.locator('table tr')).toHaveCount(3);
    await expect(editor.locator('table tr').first().locator('th, td')).toHaveCount(3);
  });

  test('file cards link to the upload, and pasting a URL over text makes a link', async ({ page, context, request }) => {
    const user = await createUser(request, 'File Link');
    const { pageId } = await createPage(request, user, { page: 'Files' });
    await signInContext(context, user);
    const editor = await openPage(page, user.wsId, pageId);
    await focusEnd(page);
    await page.keyboard.type('/attach');
    await expect(page.locator('.slash-menu .slash-item').first()).toBeVisible();
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Enter')]);
    await fc.setFiles({ name: 'agenda.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test') });
    const card = editor.locator('.file-card');
    await expect(card).toContainText('agenda.pdf');
    const href = await card.locator('.file-card-name').getAttribute('href');
    expect(href).toMatch(/\/uploads\/[0-9a-f]{32}\.pdf$/);
    const res = await page.request.get(href!);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-disposition']).toMatch(/^attachment/);

    await nextLine(page);
    await page.keyboard.type('Read the docs');
    await page.keyboard.press('Shift+Home');
    await page.waitForTimeout(150); // let the editor see the selection before the (synthetic) paste
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', 'https://example.com/docs');
      document.querySelector('.ProseMirror')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await expect(editor.locator('a[href="https://example.com/docs"]')).toHaveText('Read the docs');
  });
});
