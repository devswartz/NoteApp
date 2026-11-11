// Editor accessibility: a page with every block type passes axe (no serious or critical
// violations), and blocks can be used and moved with the keyboard alone.
// Owner: Editor & Notes (agent 2), coordinated with QA (docs/QA.md).
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import zlib from 'node:zlib';
import { createPage, createUser, focusEnd, openPage, signInContext } from './helpers.ts';

/** A 160×100 PNG, big enough to click past the resize handles. */
function makePng(w = 160, h = 100) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h, 0x88);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const PNG = makePng();

async function slash(page: Page, query: string) {
  await page.keyboard.type('/' + query);
  const menu = page.getByRole('listbox', { name: 'Insert block' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('option').first()).toBeVisible();
  return menu;
}

/** Put the cursor on an empty line at the end of the page (there's always a trailing paragraph). */
async function nextLine(page: Page) {
  const last = page.locator('.ProseMirror > p').last();
  await last.click();
  await page.keyboard.press('End');
  if ((await last.textContent())?.trim()) await page.keyboard.press('Enter');
}

async function buildEveryBlock(page: Page) {
  await focusEnd(page);
  await page.keyboard.type('# Heading one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Some text with a ');
  await page.keyboard.type('link', {});
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('example.com');
  await page.keyboard.press('Enter');
  await nextLine(page);
  await page.keyboard.type('- bullet');
  await nextLine(page);
  await page.keyboard.type('1. numbered');
  await nextLine(page);
  await slash(page, 'checklist');
  await page.keyboard.press('Enter');
  await page.keyboard.type('check item');
  await nextLine(page);
  await page.keyboard.type('> quoted');
  await nextLine(page);
  await slash(page, 'callout');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Callout text');
  await nextLine(page);
  await slash(page, 'toggle');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Toggle summary');
  await nextLine(page);
  await slash(page, 'code');
  await page.keyboard.press('Enter');
  await page.keyboard.type('const a = 1;');
  await nextLine(page);
  await slash(page, 'table');
  await page.keyboard.press('Enter');
  await page.keyboard.type('cell');
  await nextLine(page);
  await slash(page, 'divider');
  await page.keyboard.press('Enter');
  await nextLine(page);
  await slash(page, 'task');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Accessible task');
  await page.keyboard.press('Escape');
  await nextLine(page);
  await slash(page, 'image');
  const [img] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Enter')]);
  await img.setFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.locator('.ProseMirror img')).toBeVisible();
  await nextLine(page);
  await slash(page, 'attach');
  const [file] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Enter')]);
  await file.setFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await expect(page.locator('.file-card')).toBeVisible();
}

test.describe('editor accessibility', () => {
  test('a page with every block type has no serious or critical axe violations', async ({ page, context, request }) => {
    test.slow(); // types out every block type: ~4 s normally, past 30 s on an overloaded runner
    const user = await createUser(request, 'Axe Tester');
    const { pageId } = await createPage(request, user, { page: 'Every block' });
    await signInContext(context, user);
    await openPage(page, user.wsId, pageId);
    await buildEveryBlock(page);
    for (const sel of ['h1', 'ul:not([data-type])', 'ol', 'ul[data-type="taskList"]', 'blockquote', '.callout', '.toggle', '.code-block', 'table', 'hr', '.task-ref', 'img', '.file-card']) {
      await expect(page.locator(`.ProseMirror ${sel}`).first(), sel).toBeVisible();
    }
    // Also with the formatting toolbar open.
    await page.locator('.ProseMirror h1').click();
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');
    await expect(page.getByRole('toolbar', { name: 'Formatting' })).toBeVisible();

    // The side panel's task rows are the dashboard's TaskRow (Tasks/UI Shell); they're covered
    // by their owners' checks, so this one is about the editor and page chrome. The same goes
    // for the assignee avatar (white initials on the person's colour), which the ribbon's
    // layout now brings into the viewport.
    const results = await new AxeBuilder({ page })
      .include('.page-layout')
      .include('.bubble-menu')
      .exclude('.task-row')
      .analyze();
    const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(bad.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')})`)).toEqual([]);
  });

  test('blocks move with Alt+Shift+↑/↓, toggles open with the keyboard, the toolbar is reachable with Alt+F10', async ({ page, context, request }) => {
    const user = await createUser(request, 'Keyboard Only');
    const { pageId } = await createPage(request, user, { page: 'Keys' });
    await signInContext(context, user);
    const editor = await openPage(page, user.wsId, pageId);
    await focusEnd(page);
    await page.keyboard.type('first');
    await page.keyboard.press('Enter');
    await page.keyboard.type('second');
    await page.keyboard.press('Alt+Shift+ArrowUp');
    await expect(editor.locator('p').nth(0)).toHaveText('second');
    await page.keyboard.press('Alt+Shift+ArrowDown');
    await expect(editor.locator('p').nth(0)).toHaveText('first');

    // Toggle: its button is keyboard-focusable and reports its state.
    await nextLine(page);
    await slash(page, 'toggle');
    await page.keyboard.press('Enter');
    await page.keyboard.type('More');
    const toggleButton = editor.locator('.toggle > button');
    await expect(toggleButton).toHaveAttribute('aria-expanded', /true|false/);
    const before = await toggleButton.getAttribute('aria-expanded');
    await toggleButton.focus();
    await page.keyboard.press('Enter');
    await expect(toggleButton).not.toHaveAttribute('aria-expanded', before!);

    // Formatting toolbar from the keyboard: select, Alt+F10, arrows, Enter, Escape back to the text.
    await editor.locator('p').first().click();
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');
    // Wait for the selection's toolbar to be showing (and focusable) before asking for it.
    const toolbar = page.getByRole('toolbar', { name: 'Formatting' });
    await expect(toolbar.getByRole('button', { name: /^Bold/ })).toBeVisible();
    await expect(async () => {
      await page.keyboard.press('Alt+F10');
      await expect(toolbar.locator(':focus')).toHaveCount(1, { timeout: 1000 });
    }).toPass({ timeout: 10_000 });
    const bold = toolbar.getByRole('button', { name: /^Bold/ });
    for (let i = 0; i < 10 && !(await bold.evaluate((b) => b === document.activeElement)); i++) await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await expect(editor.locator('strong')).toHaveText('first');
    await page.keyboard.press('Escape');
    await expect(editor).toBeFocused();
  });

  test('images get an editable alt text', async ({ page, context, request }) => {
    const user = await createUser(request, 'Alt Text');
    const { pageId } = await createPage(request, user, { page: 'Alt' });
    await signInContext(context, user);
    const editor = await openPage(page, user.wsId, pageId);
    await focusEnd(page);
    await slash(page, 'image');
    const [img] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Enter')]);
    await img.setFiles({ name: 'chart.png', mimeType: 'image/png', buffer: PNG });
    await expect(editor.locator('img')).toHaveAttribute('alt', 'chart.png');
    await editor.locator('img').click();
    const alt = page.getByRole('textbox', { name: 'Image description (alt text)' });
    await alt.fill('Revenue by quarter');
    await alt.press('Enter');
    await expect(editor.locator('img')).toHaveAttribute('alt', 'Revenue by quarter');
  });
});
