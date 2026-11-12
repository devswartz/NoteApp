// Copy keeps the formatting: a nested bullet list and a numbered list copied by every path (selected box, Ctrl+C on a normal
// selection, Ctrl+C on Ctrl-picked lines, right-click Copy) paste with their list structure into another box, another page,
// the empty canvas (a new box), and the clipboard carries real HTML (and "- " / "1. " text) for other apps.
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { stubClipboard } from './clipboard.ts';
import { api, createPage, createUser, openPage, signInContext, type TestUser } from './helpers.ts';

type J = Record<string, unknown>;
const text = (t: string, marks?: J[]): J => ({ type: 'text', text: t, ...(marks ? { marks } : {}) });
const p = (...c: J[]): J => ({ type: 'paragraph', content: c });
const li = (t: string, ...nested: J[]): J => ({ type: 'listItem', content: [p(text(t)), ...nested] });
const ul = (...items: J[]): J => ({ type: 'bulletList', content: items });
const ol = (...items: J[]): J => ({ type: 'orderedList', attrs: { start: 1 }, content: items });
const box = (x: number, y: number, w: number, content: J[]): J => ({ type: 'canvasBox', attrs: { x, y, w, z: 1 }, content });

const SOURCE = [p(text('Intro line')), ul(li('one', ul(li('inner a'), li('inner b'))), li('two')), ol(li('first'), li('second'), li('third'))];
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/** A canvas page with these boxes (made through a template). */
async function canvasPage(request: APIRequestContext, page: Page, user: TestUser, title: string, boxes: J[]) {
  const { pageId: scratch, sectionId } = await createPage(request, user, { notebook: 'Copy', page: `Scratch ${title}` });
  await api(request, 'POST', `/pages/${scratch}/templates`, user.token, { name: `T ${title}`, kind: 'canvas', content: { type: 'doc', content: boxes } });
  const { id: pageId } = await api<{ id: string }>(request, 'POST', `/sections/${sectionId}/pages`, user.token, { title });
  await openPage(page, user.wsId, pageId);
  await page.getByTestId('user-templates').locator('.template-card', { hasText: `T ${title}` }).click();
  await expect(page.locator('.canvas-box:not(.is-ready)')).toHaveCount(boxes.length);
  return { pageId, sectionId };
}
const sourceBoxes = [box(0, 0, 520, SOURCE), box(0, 460, 520, [p(text('Target:'))])];
const source = (page: Page) => page.locator('.canvas-box').first();
const target = (page: Page) => page.locator('.canvas-box').nth(1);

/** A box's content as an outline: "- one", "  - inner a", "1. first", and its plain paragraphs. */
const outline = (box: Locator) =>
  box.locator('.ProseMirror').evaluate((root) => {
    const out: string[] = [];
    const walk = (el: Element, depth: number) => {
      for (const child of Array.from(el.children)) {
        if (child.tagName === 'UL' || child.tagName === 'OL') {
          Array.from(child.children).forEach((item, i) => {
            const lead = item.querySelector(':scope > p')?.textContent ?? '';
            out.push(`${'  '.repeat(depth)}${child.tagName === 'UL' ? '-' : `${Number((child as HTMLOListElement).start || 1) + i}.`} ${lead}`);
            walk(item, depth + 1);
          });
        } else if (child.tagName === 'P' && depth === 0 && child.textContent) out.push(child.textContent); // (a trailing empty paragraph is the editor's own)
      }
    };
    walk(root, 0);
    return out;
  });

async function pointIn(par: Locator, needle: string, where: 'start' | 'mid' | 'end' = 'mid') {
  return par.evaluate(
    (el, [t, w]) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = (n.textContent ?? '').indexOf(t);
        if (i < 0) continue;
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + t.length);
        const b = r.getBoundingClientRect();
        return { x: w === 'start' ? b.left + 1 : w === 'end' ? b.right - 1 : b.left + b.width / 2, y: b.top + b.height / 2 };
      }
      throw new Error(`no "${t}"`);
    },
    [needle, where] as const,
  );
}
const line = (page: Page, t: string) => page.locator('.canvas-box li > p', { hasText: new RegExp(`^${t}$`) }).first();
async function triple(page: Page, t: string, add = false) {
  const pt = await pointIn(line(page, t), t);
  if (add) await page.keyboard.down(MOD);
  await page.mouse.click(pt.x, pt.y, { clickCount: 3 });
  if (add) await page.keyboard.up(MOD);
}
async function dragSelect(page: Page, from: string, to: string) {
  const a = await pointIn(line(page, from), from, 'start');
  const b = await pointIn(line(page, to), to, 'end');
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await page.mouse.up();
}
/** A plain click on a box's top edge: selects the box itself (focus leaves its text). */
async function selectBoxByEdge(page: Page, box: Locator) {
  await box.hover();
  const h = await box.locator('.canvas-box-move').boundingBox();
  await page.mouse.click(h!.x + h!.width / 2, h!.y + h!.height / 2);
}
/** Put the caret at the end of the target box and paste. */
async function pasteIntoTarget(page: Page) {
  await target(page).locator('.ProseMirror').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.press('ControlOrMeta+v');
}
const clipboardParts = (page: Page) =>
  page.evaluate(async () => {
    const [item] = await navigator.clipboard.read();
    if (!item) return { types: [] as string[], html: null, plain: null }; // nothing copied yet
    const read = async (type: string) => (item.types.includes(type) ? await (await item.getType(type)).text() : null);
    const plain = await read('text/plain');
    return { types: item.types, html: await read('text/html'), plain: plain && plain.replace(/\r\n?/g, '\n') }; // Windows adds CR
  });

// Each page has its own clipboard (clipboard.ts): the system one is shared with every other test on the machine.
test.beforeEach(async ({ page }) => {
  await stubClipboard(page);
});

test('a selected box (click its top edge, Ctrl+C) pastes into another box with its bullets, nesting and numbering', async ({ page, context, request }) => {
  const user = await createUser(request, 'Bea Box');
  await signInContext(context, user);
  await canvasPage(request, page, user, 'Box copy', sourceBoxes);
  await selectBoxByEdge(page, source(page));
  await page.keyboard.press('ControlOrMeta+c');

  // Real HTML and text on the clipboard, for other apps.
  await expect.poll(async () => (await clipboardParts(page)).types).toContain('text/html');
  const parts = await clipboardParts(page);
  expect(parts.html).toMatch(/<ul>.*<li>.*one.*<ul>.*inner a.*<\/ul>.*<\/li>.*<\/ul>/s);
  expect(parts.html).toMatch(/<ol[^>]*>.*first.*second.*third.*<\/ol>/s);
  expect(parts.plain).toContain('- one\n  - inner a\n  - inner b\n- two\n1. first\n2. second\n3. third');

  await pasteIntoTarget(page);
  const pasted = await outline(target(page));
  expect(pasted).toEqual(expect.arrayContaining(['- one', '  - inner a', '  - inner b', '- two', '1. first', '2. second', '3. third']));
});

test('Ctrl+C on a normal selection across list items pastes with its structure', async ({ page, context, request }) => {
  const user = await createUser(request, 'Nora Normal');
  await signInContext(context, user);
  await canvasPage(request, page, user, 'Normal copy', sourceBoxes);
  await dragSelect(page, 'inner b', 'second');
  await page.keyboard.press('ControlOrMeta+c');
  await pasteIntoTarget(page);
  const pasted = (await outline(target(page))).filter((l) => l !== 'Target:');
  expect(pasted.join('|')).toMatch(/inner b.*\|.*two.*\|.*1\. first.*\|.*2\. second/);
  expect(pasted.some((l) => /^\s*[-\d.]+ $/.test(l)), 'no empty items').toBe(false);
});

test('Ctrl-picked lines copy as lists, in reading order, without empty items (Ctrl+C and right-click Copy)', async ({ page, context, request }) => {
  const user = await createUser(request, 'Pia Picker');
  await signInContext(context, user);
  await canvasPage(request, page, user, 'Pick copy', sourceBoxes);
  await triple(page, 'one');
  await triple(page, 'inner b', true);
  await triple(page, 'second', true);

  await page.keyboard.press('ControlOrMeta+c');
  await expect.poll(async () => (await clipboardParts(page)).html ?? '').toContain('<li>');
  const parts = await clipboardParts(page);
  expect(parts.plain).toBe('- one\n- inner b\n2. second');
  expect(parts.html).toMatch(/<ol[^>]*start="2"/);
  await pasteIntoTarget(page);
  expect((await outline(target(page))).filter((l) => l !== 'Target:' && l !== '')).toEqual(['- one', '- inner b', '2. second']);

  // The right-click menu's Copy gives the same (picks are dropped by pasting: pick again).
  await triple(page, 'one');
  await triple(page, 'inner b', true);
  await triple(page, 'second', true);
  await page.evaluate(() => navigator.clipboard.writeText('overwritten'));
  await page.locator('.canvas-box .is-range-picked').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Copy' }).click();
  await expect.poll(async () => (await clipboardParts(page)).plain).toBe('- one\n- inner b\n2. second');
  expect((await clipboardParts(page)).html).toContain('<li>');
});

test('copied lists paste into a box on another page', async ({ page, context, request }) => {
  const user = await createUser(request, 'Otto Other');
  await signInContext(context, user);
  const { sectionId } = await canvasPage(request, page, user, 'From page', sourceBoxes);
  const other = await api<{ id: string }>(request, 'POST', `/sections/${sectionId}/pages`, user.token, { title: 'To page', kind: 'canvas' });
  await triple(page, 'two');
  await triple(page, 'third', true);
  await page.keyboard.press('ControlOrMeta+c');
  await expect.poll(async () => (await clipboardParts(page)).html ?? '').toContain('<li>');
  await page.goto(`/w/${user.wsId}/p/${other.id}`);
  await expect(page.getByTestId('canvas-surface')).toBeVisible();
  await page.getByTestId('canvas-surface').click({ position: { x: 40, y: 240 } });
  await expect(page.locator('.canvas-box:not(.is-ready)')).toHaveCount(1);
  await expect(page.locator('.canvas-box .ProseMirror:focus')).toHaveText('');
  await page.keyboard.press('ControlOrMeta+v');
  expect((await outline(page.locator('.canvas-box').first())).filter(Boolean)).toEqual(['- two', '3. third']);
});

test('pasting onto the empty canvas makes a new box with the lists: from HTML, and from plain text with "- " and "1. " lines', async ({ page, context, request }) => {
  const user = await createUser(request, 'Cleo Canvas');
  await signInContext(context, user);
  const { sectionId } = await createPage(request, user, { notebook: 'Paste', page: 'Scratch' });
  const { id } = await api<{ id: string }>(request, 'POST', `/sections/${sectionId}/pages`, user.token, { title: 'Paste here', kind: 'canvas' });
  await page.goto(`/w/${user.wsId}/p/${id}`);
  await expect(page.getByTestId('canvas-surface')).toBeVisible();
  await expect(page.locator('.sync-live')).toBeVisible({ timeout: 15_000 });
  // A box to select by its edge, so the paste goes to the canvas and not into a text.
  await page.getByTestId('canvas-surface').click({ position: { x: 40, y: 240 } });
  await expect(page.locator('.canvas-box .ProseMirror:focus')).toHaveText('');
  await page.keyboard.type('anchor');
  await selectBoxByEdge(page, page.locator('.canvas-box').first());

  // From another app: HTML with lists.
  await page.evaluate(async () => {
    const html = '<ul><li>apple<ul><li>green</li></ul></li><li>pear</li></ul><ol><li>x</li><li>y</li></ol>';
    await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob(['apple green pear x y'], { type: 'text/plain' }) })]);
  });
  await page.keyboard.press('ControlOrMeta+v');
  await expect(page.locator('.canvas-box:not(.is-ready)')).toHaveCount(2);
  expect(await outline(page.locator('.canvas-box', { hasText: 'apple' }))).toEqual(['- apple', '  - green', '- pear', '1. x', '2. y']);

  // Plain text only: "- " and "1. " lines become lists.
  await selectBoxByEdge(page, page.locator('.canvas-box', { hasText: 'anchor' }));
  await page.evaluate(() => navigator.clipboard.writeText('Shopping\n- milk\n  - oat\n- eggs\n1. wake\n2. coffee'));
  await page.keyboard.press('ControlOrMeta+v');
  await expect(page.locator('.canvas-box:not(.is-ready)')).toHaveCount(3);
  expect(await outline(page.locator('.canvas-box', { hasText: 'Shopping' }))).toEqual(['Shopping', '- milk', '  - oat', '- eggs', '1. wake', '2. coffee']);
});
