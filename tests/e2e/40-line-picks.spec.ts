// Word-style multi-selection (Ctrl/Cmd held for the next selection keeps the earlier ones), inside and across boxes:
// the first selection is the browser's own (drag, double-click a word, triple-click a line); Ctrl+drag / +double-click /
// +triple-click adds another range. "Print selection" prints exactly those ranges, the right-click menu, Copy, and a
// selection from an untitled page printing without a title. Set E2E_SHOTS=<dir> to also save screenshots.
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { stubClipboard } from './clipboard.ts';
import { api, createPage, createTeam, createUser, openPage, pageUrl, ribbon, signInContext, type TestUser } from './helpers.ts';

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
async function canvasPage(request: APIRequestContext, page: Page, user: TestUser, pageTitle: string, boxes: J[], wsId = user.wsId) {
  const { pageId: scratch, sectionId } = await createPage(request, user, { wsId, notebook: 'Picks', page: 'Scratch' });
  await api(request, 'POST', `/pages/${scratch}/templates`, user.token, { name: 'Picks template', kind: 'canvas', content: { type: 'doc', content: boxes } });
  const { id: pageId } = await api<{ id: string }>(request, 'POST', `/sections/${sectionId}/pages`, user.token, { title: pageTitle });
  await openPage(page, wsId, pageId);
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

const link = (href: string, label: string): J => text(label, [{ type: 'link', attrs: { href } }]);
const twoBoxes = [
  box(0, 0, 520, [p(text('The quick brown fox')), p(text('jumps over the lazy dog')), p(text('Pack my box with five jugs')), p(text('Visit '), link('https://example.com/docs', 'the docs'), text(' now'))]),
  box(0, 400, 520, [p(text('Sphinx of black quartz')), p(text('judge my vow'))]),
];

// ── gestures: real mouse input at points inside the text, with Ctrl/Cmd held for the "add" ones ──
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const para = (page: Page, t: string) => page.locator('.canvas-box p', { hasText: t }).first();
type At = 'start' | 'mid' | 'end';
/** A point inside `t` in a paragraph: just in from its start, its middle, or just in from its end (page coordinates). */
async function pointIn(par: Locator, t: string, at: At = 'mid') {
  return par.evaluate(
    (el, [needle, where]) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = (n.textContent ?? '').indexOf(needle);
        if (i < 0) continue;
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + needle.length);
        const b = r.getBoundingClientRect();
        return { x: where === 'start' ? b.left + 1 : where === 'end' ? b.right - 1 : b.left + b.width / 2, y: b.top + b.height / 2 };
      }
      throw new Error(`no "${needle}"`);
    },
    [t, at] as const,
  );
}
async function withMod(page: Page, add: boolean, fn: () => Promise<void>) {
  if (add) await page.keyboard.down(MOD);
  try {
    await fn();
  } finally {
    if (add) await page.keyboard.up(MOD);
  }
}
/** Double-click a word (Ctrl/Cmd held when `add`). */
async function dblclick(page: Page, par: Locator, word: string, add = false) {
  const pt = await pointIn(par, word);
  await withMod(page, add, () => page.mouse.dblclick(pt.x, pt.y));
}
/** Triple-click a line. */
async function triple(page: Page, par: Locator, word: string, add = false) {
  const pt = await pointIn(par, word);
  await withMod(page, add, () => page.mouse.click(pt.x, pt.y, { clickCount: 3 }));
}
/** Drag from the start of `from` to the end of `to` (both in the same paragraph, or different ones). */
async function drag(page: Page, fromPar: Locator, from: string, toPar: Locator, to: string, add = false) {
  const a = await pointIn(fromPar, from, 'start');
  const b = await pointIn(toPar, to, 'end');
  await withMod(page, add, async () => {
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
    await page.mouse.move(b.x, b.y, { steps: 6 });
    await page.mouse.up();
  });
}
/** A Ctrl/Cmd+click with no drag. */
async function click(page: Page, par: Locator, word: string, add = false, button: 'left' | 'right' = 'left') {
  const pt = await pointIn(par, word);
  await withMod(page, add, () => page.mouse.click(pt.x, pt.y, { button }));
}

/** The browser's own selection, and the ranges kept as picks. */
const live = (page: Page) => page.evaluate(() => (getSelection()?.toString() ?? '').replace(/\s+/g, ' ').trim());
const picked = async (page: Page) => (await page.locator('.canvas-box .is-range-picked').allInnerTexts()).join('').replace(/\s+/g, ' ').trim();
const printButton = (page: Page) => ribbon(page).getByRole('button', { name: 'Print selection', exact: true });
const squish = (s: string) => s.replace(/\s+/g, ' ').trim();

async function printNow(page: Page) {
  const before = await printed(page);
  await printButton(page).click();
  await expect.poll(() => printed(page)).toBe(before + 1);
  await page.emulateMedia({ media: 'print' });
}

// Each page has its own clipboard (clipboard.ts): the system one is shared with every other test running.
test.beforeEach(async ({ page }) => {
  await stubClipboard(page);
});

test('double-click a word, then Ctrl+double-click another: only those two words print; the first stays highlighted', async ({ page, context, request }) => {
  const user = await createUser(request, 'Wes Words');
  await signInContext(context, user);
  await stubPrint(page);
  await canvasPage(request, page, user, 'Field notes', twoBoxes);

  await dblclick(page, para(page, 'The quick'), 'quick');
  expect(await live(page)).toBe('quick'); // the first selection is the browser's own
  expect(await picked(page)).toBe('');
  await dblclick(page, para(page, 'jumps over'), 'lazy', true);
  expect(await picked(page)).toBe('quick'); // kept while the new one is made
  expect(await live(page)).toBe('lazy');
  await shot(page, 'words-picked');

  // Ctrl/Cmd+C copies every picked piece.
  await page.keyboard.press(`${MOD}+c`);
  await expect.poll(async () => squish(await page.evaluate(() => navigator.clipboard.readText()))).toBe('quick lazy'); // (the copy completes a moment after the key)

  await printNow(page);
  const root = page.locator('#print-root');
  await expect(root.locator('.print-title')).toHaveText('Field notes');
  await expect(root.locator('.print-box')).toHaveText([/^\s*quick\s*lazy\s*$/]);
  for (const gone of ['brown', 'fox', 'jumps', 'dog']) await expect(root).not.toContainText(gone);
});

test('drag part of a line, then Ctrl+drag part of a line in another box: both ranges print, partial, in reading order', async ({ page, context, request }) => {
  const user = await createUser(request, 'Dara Drag');
  await signInContext(context, user);
  await stubPrint(page);
  await canvasPage(request, page, user, 'Drags', twoBoxes);

  const first = para(page, 'The quick');
  await drag(page, first, 'quick', first, 'brown');
  expect(await live(page)).toBe('quick brown');
  await drag(page, para(page, 'Sphinx'), 'black', para(page, 'Sphinx'), 'quartz', true);
  expect(await picked(page)).toBe('quick brown'); // the other box's earlier range stays picked
  expect(await live(page)).toBe('black quartz');

  await printNow(page);
  const root = page.locator('#print-root');
  await expect(root.locator('.print-box')).toHaveText([/^\s*quick brown\s*$/, /^\s*black quartz\s*$/]);
  for (const gone of ['The ', 'fox', 'Sphinx', 'of black', 'judge']) await expect(root).not.toContainText(gone);
});

test('Ctrl+triple-click adds a whole line; Ctrl+click with no drag adds nothing but keeps what was picked', async ({ page, context, request }) => {
  const user = await createUser(request, 'Tri Click');
  await signInContext(context, user);
  await stubPrint(page);
  await canvasPage(request, page, user, 'Lines', twoBoxes);

  await dblclick(page, para(page, 'The quick'), 'The');
  await triple(page, para(page, 'jumps over'), 'lazy', true);
  expect(await live(page)).toBe('jumps over the lazy dog');
  expect(await picked(page)).toBe('The');
  await printNow(page);
  const root = page.locator('#print-root');
  await expect(root.locator('.print-box')).toHaveText([/^\s*The\s*jumps over the lazy dog\s*$/]);
  await expect(root).not.toContainText('quick');
  await page.emulateMedia({ media: 'screen' });

  // A Ctrl+click without a drag only places the caret: nothing new is picked, what was picked stays.
  await page.keyboard.press('Escape');
  await dblclick(page, para(page, 'The quick'), 'quick');
  await click(page, para(page, 'Pack my'), 'jugs', true);
  expect(await picked(page)).toBe('quick');
  expect(await live(page)).toBe('');
  await printNow(page);
  await expect(root.locator('.print-box')).toHaveText([/^\s*quick\s*$/]);
});

test('Ctrl+click on a link still opens it (and keeps the selection made so far); on a box frame it picks the whole box', async ({ page, context, request }) => {
  const user = await createUser(request, 'Lin Kopen');
  await signInContext(context, user);
  await stubPrint(page);
  await canvasPage(request, page, user, 'Links', twoBoxes);

  await dblclick(page, para(page, 'The quick'), 'quick');
  // The headless browser doesn't open links from an editable area, so check what matters here: our handling leaves the
  // click to the browser (the press and the click both get through to the page, neither swallowed), and what was
  // selected so far stays picked.
  await page.evaluate(() => {
    const w = window as unknown as { __seen: string[] };
    w.__seen = [];
    for (const type of ['mousedown', 'click']) window.addEventListener(type, () => w.__seen.push(type));
  });
  await click(page, para(page, 'Visit'), 'the docs', true);
  expect(await page.evaluate(() => (window as unknown as { __seen: string[] }).__seen)).toEqual(['mousedown', 'click']);
  expect(await picked(page)).toBe('quick');

  await page.keyboard.press('Escape');
  await expect(page.locator('.canvas-box .is-range-picked')).toHaveCount(0);
  // The frame: the box's left padding, outside its text.
  await page.locator('.canvas-box', { hasText: 'Sphinx' }).click({ modifiers: [MOD === 'Meta' ? 'Meta' : 'Control'], position: { x: 4, y: 12 } });
  await expect(page.locator('.canvas-box.is-picked')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('.canvas-box.is-picked')).toHaveCount(0);
});

test('Escape or a plain click clears every pick and the selection', async ({ page, context, request }) => {
  const user = await createUser(request, 'Clea Rer');
  await signInContext(context, user);
  await stubPrint(page);
  await canvasPage(request, page, user, 'Clear', twoBoxes);

  await dblclick(page, para(page, 'The quick'), 'quick');
  await dblclick(page, para(page, 'jumps over'), 'lazy', true);
  expect(await picked(page)).toBe('quick');
  await page.keyboard.press('Escape');
  expect(await picked(page)).toBe('');
  expect(await live(page)).toBe('');
  await expect(printButton(page)).toHaveCount(0);

  // (Other words this time: a second double-click on the same spot soon after the first counts as a triple-click.)
  await dblclick(page, para(page, 'The quick'), 'brown');
  await dblclick(page, para(page, 'jumps over'), 'dog', true);
  expect(await picked(page)).toBe('brown');
  await click(page, para(page, 'Pack my'), 'jugs'); // a plain click
  expect(await picked(page)).toBe('');
  expect(await live(page)).toBe('');
});

test('right-click: Print selection over picks or a multi-word selection; a single word and everything else keep the browser menu', async ({ page, context, request }) => {
  const user = await createUser(request, 'Rory Rightclick');
  await signInContext(context, user);
  await stubPrint(page);
  await canvasPage(request, page, user, 'Menus', twoBoxes);
  const item = page.getByRole('menuitem', { name: 'Print selection' });

  // Nothing selected: the browser's own menu (no menu of ours).
  await click(page, para(page, 'Pack my'), 'five', false, 'right');
  await expect(item).toHaveCount(0);
  await page.keyboard.press('Escape');

  // One selected word keeps the browser's menu, so a misspelling can still be corrected.
  await dblclick(page, para(page, 'The quick'), 'brown');
  await click(page, para(page, 'The quick'), 'brown', false, 'right');
  await expect(item).toHaveCount(0);
  await page.keyboard.press('Escape');

  // More than one word: ours.
  const f = para(page, 'jumps over');
  await drag(page, f, 'over', f, 'lazy');
  await click(page, f, 'the', false, 'right');
  await expect(item).toBeVisible();
  await page.keyboard.press('Escape');

  // Picks: right-click a picked word, or the live selection once something is picked.
  await dblclick(page, para(page, 'The quick'), 'quick');
  await dblclick(page, para(page, 'Sphinx'), 'black', true);
  await click(page, para(page, 'The quick'), 'quick', false, 'right');
  await expect(item).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Copy' })).toBeVisible();
  await shot(page, 'selection-menu');
  await item.click();
  await expect.poll(() => printed(page)).toBe(1);
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('#print-root .print-box')).toHaveText([/^\s*quick\s*$/, /^\s*black\s*$/]);
});

test('a selection from an untitled page prints without a title; a titled one keeps a small title', async ({ page, context, request }) => {
  const user = await createUser(request, 'Una Titled');
  await signInContext(context, user);
  await stubPrint(page);
  await canvasPage(request, page, user, '', twoBoxes);

  await dblclick(page, para(page, 'Sphinx'), 'black');
  await dblclick(page, para(page, 'judge'), 'vow', true);
  await printNow(page);
  const root = page.locator('#print-root');
  await expect(root.locator('.print-box')).toHaveText([/^\s*black\s*vow\s*$/]);
  await expect(root.locator('.print-title')).toHaveCount(0);
  await expect(root).not.toContainText('Untitled');
});

test('a named page prints its title with a selection, including a page shared from another workspace', async ({ browser, page, context, request }) => {
  const user = await createUser(request, 'Nina Named');
  await signInContext(context, user);
  await stubPrint(page);
  await canvasPage(request, page, user, 'Quarterly plan', twoBoxes);
  await dblclick(page, para(page, 'Sphinx'), 'black');
  await dblclick(page, para(page, 'judge'), 'vow', true);
  await printNow(page);
  await expect(page.locator('#print-root .print-title')).toHaveText('Quarterly plan');
  // The title is the whole-page title: same size, weight, spacing and rule (only the notebook/date line is left out).
  const titleStyle = () =>
    page.locator('#print-root .print-head').evaluate((head) => {
      const t = getComputedStyle(head.querySelector('.print-title')!);
      const h = getComputedStyle(head);
      return { size: t.fontSize, weight: t.fontWeight, line: t.lineHeight, spacing: t.letterSpacing, color: t.color, margin: h.marginBottom, pad: h.paddingBottom, rule: h.borderBottomWidth };
    });
  const selectionTitle = await titleStyle();
  await expect(page.locator('#print-root .print-sub')).toHaveCount(0);
  await page.emulateMedia({ media: 'screen' });
  await page.locator('.canvas-box').first().locator('.ProseMirror').click(); // drops the picks
  await page.keyboard.press('ControlOrMeta+p');
  await expect.poll(() => printed(page)).toBe(2);
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('#print-root .print-sub')).toHaveCount(1); // the whole page has its notebook and date line
  expect(await titleStyle()).toEqual(selectionTitle);
  await page.emulateMedia({ media: 'screen' });

  // A page shared from another workspace isn't in the viewer's page list: its title must still print.
  const alice = await createUser(request, 'Alice Owner');
  const olga = await createUser(request, 'Olga Outsider');
  const teamId = await createTeam(request, alice, [], 'Closed Team');
  const a = await browser.newContext();
  await signInContext(a, alice);
  const ap = await a.newPage();
  const sharedId = await canvasPage(request, ap, alice, 'Shared named note', twoBoxes, teamId);
  await api(request, 'POST', `/pages/${sharedId}/shares`, alice.token, { email: olga.email, canEdit: false });
  const o = await browser.newContext();
  await signInContext(o, olga);
  const op = await o.newPage();
  await stubPrint(op);
  await op.goto(pageUrl(olga.wsId, sharedId));
  await expect(op.locator('.canvas-box:not(.is-ready)')).toHaveCount(2);
  await dblclick(op, para(op, 'Sphinx'), 'black');
  await dblclick(op, para(op, 'judge'), 'vow', true);
  await printNow(op);
  await expect(op.locator('#print-root .print-title')).toHaveText('Shared named note');
  await expect(op.locator('#print-root')).not.toContainText('Untitled');
  await a.close();
  await o.close();
});
