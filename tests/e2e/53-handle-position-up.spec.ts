// Moving up from a nested list line to a shallower block (its parent, a heading above the list): the handle sits left of that block's text each
// time, never over its first letters.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { api, createPage, createUser, openPage, signInContext } from './helpers.ts';

type J = Record<string, unknown>;
const p = (t: string): J => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });
const li = (t: string, ...kids: J[]): J => ({ type: 'listItem', content: [p(t), ...kids] });
const ul = (...items: J[]): J => ({ type: 'bulletList', content: items });
const heading = (t: string): J => ({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: t }] });

async function open(page: Page, request: Parameters<typeof createPage>[0], user: Awaited<ReturnType<typeof createUser>>, width: number, x = 140) {
  const { pageId: scratch, sectionId } = await createPage(request, user, { notebook: 'Up', page: 'Scratch' });
  const content = {
    type: 'doc',
    content: [{ type: 'canvasBox', attrs: { x, y: 0, w: width, z: 1, wide: width > 500 }, content: [heading('Agenda'), p('Plain paragraph'), ul(li('Alpha', ul(li('Beta', ul(li('Gamma')))))), { type: 'paragraph' }, p('Closing')] }],
  };
  await api(request, 'POST', `/pages/${scratch}/templates`, user.token, { name: 'Up template', kind: 'canvas', content });
  const { id } = await api<{ id: string }>(request, 'POST', `/sections/${sectionId}/pages`, user.token, { title: 'Up' });
  await openPage(page, user.wsId, id);
  await page.getByTestId('user-templates').locator('.template-card', { hasText: 'Up template' }).click();
  await expect(page.locator('.canvas-box:not(.is-ready)')).toHaveCount(1);
}

/** Where the text of a block starts (left edge of its first character). */
const textLeft = (box: Locator, t: string) =>
  box.locator('h1, h2, h3, p').filter({ hasText: new RegExp(`^${t}$`) }).first().evaluate((el) => {
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const n = w.nextNode()!;
    const r = document.createRange();
    r.setStart(n, 0);
    r.setEnd(n, 1);
    return r.getBoundingClientRect().left;
  });
const mid = (b: { y: number; height: number }) => b.y + b.height / 2;

for (const [label, width] of [['wide', 640], ['narrow', 260]] as const) {
  test(`the handle stays left of the text when the pointer moves up to a shallower block (${label} box)`, async ({ page, context, request }) => {
    const user = await createUser(request, `Up ${label}`);
    await signInContext(context, user);
    await open(page, request, user, width);
    const box = page.locator('.canvas-box').first();
    await box.locator('.ProseMirror').click();
    const handle = page.locator('.block-handle').first();
    const gamma = (await box.locator('p').filter({ hasText: /^Gamma$/ }).first().boundingBox())!;
    const x0 = gamma.x + 20; // the child's text: moving straight up keeps this x, which is inside the shallower lines' text

    // Level 3, then up to level 2, level 1, the paragraph and the heading: after each move the whole handle (✓ and ⋮⋮) ends left of the block's text.
    for (const t of ['Gamma', 'Beta', 'Alpha', 'Plain paragraph', 'Agenda']) {
      const el = box.locator('h1, h2, h3, p').filter({ hasText: new RegExp(`^${t}$`) }).first();
      const b = (await el.boundingBox())!;
      const y = mid(b);
      // Straight up from where the pointer was (same x, the child's text), in small steps like a hand, then wait out the 300 ms grace period.
      await page.mouse.move(x0, y, { steps: 12 });
      await page.waitForTimeout(450);
      const h = (await handle.boundingBox())!;
      expect(h, `${t}: handle shown`).not.toBeNull();
      expect(Math.abs(mid(h) - y), `${t}: beside its own line`).toBeLessThan(14);
      const left = await textLeft(box, t);
      expect(h.x + h.width, `${t}: the handle (right edge ${Math.round(h.x + h.width)}) must end left of the text (starts ${Math.round(left)})`).toBeLessThanOrEqual(left - 2);
    }
  });
}

test('from an empty line (no ✓ on its handle) up to a line that has one, the handle is still left of the text', async ({ page, context, request }) => {
  const user = await createUser(request, 'Up empty');
  await signInContext(context, user);
  await open(page, request, user, 640);
  const box = page.locator('.canvas-box').first();
  await box.locator('.ProseMirror').click();
  const empty = (await box.locator('p').filter({ hasText: /^$/ }).last().boundingBox())!;
  await page.mouse.move(empty.x + 20, mid(empty), { steps: 8 });
  await page.waitForTimeout(450);
  for (const t of ['Alpha', 'Agenda']) {
    const b = (await box.locator('h1, h2, h3, p').filter({ hasText: new RegExp(`^${t}$`) }).first().boundingBox())!;
    await page.mouse.move(empty.x + 20, mid(b), { steps: 12 });
    await page.waitForTimeout(450);
    const h = (await page.locator('.block-handle').first().boundingBox())!;
    const left = await textLeft(box, t);
    expect(h.x + h.width, `${t}: handle ends left of the text`).toBeLessThanOrEqual(left - 2);
  }
});

test('a box at the very left of the page: the handle stays inside the page area, above the sidebar, and can be clicked', async ({ page, context, request }) => {
  const user = await createUser(request, 'Up left');
  await signInContext(context, user);
  await open(page, request, user, 640, 0);
  const box = page.locator('.canvas-box').first();
  await box.locator('.ProseMirror').click();
  const area = (await page.locator('.page-scroll').first().boundingBox())!;
  for (const t of ['Gamma', 'Alpha', 'Agenda']) {
    const b = (await box.locator('h1, h2, h3, p').filter({ hasText: new RegExp(`^${t}$`) }).first().boundingBox())!;
    await page.mouse.move(b.x + 20, mid(b), { steps: 8 });
    await page.waitForTimeout(450);
    const h = (await page.locator('.block-handle').first().boundingBox())!;
    expect(h.x, `${t}: the handle is not under the sidebar`).toBeGreaterThanOrEqual(area.x);
    // Whatever is at the handle's centre is the handle (not the sidebar's pages panel).
    const top = await page.evaluate(([x, y]) => (document.elementFromPoint(x!, y!)?.closest('.block-handle') ? 'handle' : document.elementFromPoint(x!, y!)?.className), [h.x + h.width / 2, h.y + h.height / 2]);
    expect(top, `${t}: the handle can be clicked`).toBe('handle');
    // ...and it covers none of the box's text (there is a gutter for it: no overlay).
    expect(h.x + h.width, `${t}: the handle ends left of the text`).toBeLessThanOrEqual((await textLeft(box, t)) - 2);
  }
});

