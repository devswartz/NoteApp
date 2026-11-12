// Dragging in an outline: the handle follows the line you point at (in every box, not just the main one), and dragging
// a point moves its sub-points with it. Set E2E_SHOTS=<dir> to also save screenshots.
import { expect, test, type Page } from '@playwright/test';
import { api, createPage, createUser, openPage, signInContext } from './helpers.ts';

type J = Record<string, unknown>;
const p = (t: string): J => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });
const li = (t: string, ...kids: J[]): J => ({ type: 'listItem', content: [p(t), ...kids] });
const ul = (...items: J[]): J => ({ type: 'bulletList', content: items });

const outline = () =>
  ul(li('Point one', ul(li('Sub 1a'), li('Sub 1b', ul(li('Deep 1b-i'))))), li('Point two'), li('Point three', ul(li('Sub 3a'))));

async function openOutline(page: Page, request: Parameters<typeof createPage>[0], user: Awaited<ReturnType<typeof createUser>>) {
  const { pageId: scratch, sectionId } = await createPage(request, user, { notebook: 'Outlines', page: 'Scratch' });
  const content = {
    type: 'doc',
    content: [
      { type: 'canvasBox', attrs: { x: 0, y: 0, w: 600, z: 1, wide: true }, content: [p('Intro'), outline(), p('Closing')] },
      { type: 'canvasBox', attrs: { x: 0, y: 420, w: 420, z: 2 }, content: [ul(li('Other point', ul(li('Other sub'))), li('Other two'))] },
    ],
  };
  await api(request, 'POST', `/pages/${scratch}/templates`, user.token, { name: 'Outline template', kind: 'canvas', content });
  const { id } = await api<{ id: string }>(request, 'POST', `/sections/${sectionId}/pages`, user.token, { title: 'Outline' });
  await openPage(page, user.wsId, id);
  await page.getByTestId('user-templates').locator('.template-card', { hasText: 'Outline template' }).click();
  await expect(page.locator('.canvas-box:not(.is-ready)')).toHaveCount(2);
}

const para = (box: ReturnType<Page['locator']>, t: string) => box.locator('p', { hasText: new RegExp(`^${t}$`) }).first();
/** The outline as indented text: each item's own line, two spaces per level. */
const shape = (box: ReturnType<Page['locator']>) =>
  box.locator('li > p').evaluateAll((ps) =>
    ps.map((p) => {
      let depth = 0;
      for (let e = p.parentElement; e; e = e.parentElement) if (e.tagName === 'LI') depth++;
      return `${'  '.repeat(depth - 1)}${p.textContent}`;
    }),
  );

async function hover(page: Page, line: ReturnType<Page['locator']>) {
  const b = await line.boundingBox();
  if (!b) throw new Error('no line');
  await page.mouse.move(b.x + 30, b.y + b.height / 2, { steps: 6 });
  await page.waitForTimeout(250);
  return b;
}

test('the handle follows the line you point at in a list, in the main box and in other boxes', async ({ page, context, request }) => {
  const user = await createUser(request, 'Hana Handle');
  await signInContext(context, user);
  await openOutline(page, request, user);
  const main = page.locator('.canvas-box').first();
  const other = page.locator('.canvas-box').nth(1);
  await main.locator('.ProseMirror').click(); // the box being edited shows its handle

  // Beside each point, whatever its depth: not stuck at the first line of the list.
  for (const t of ['Point one', 'Sub 1a', 'Deep 1b-i', 'Point two', 'Point three', 'Sub 3a']) {
    const line = await hover(page, para(main, t));
    const grip = await page.locator('.block-handle').first().boundingBox();
    expect(grip, t).not.toBeNull();
    expect(Math.abs(grip!.y + grip!.height / 2 - (line.y + line.height / 2)), `${t}: handle beside the line`).toBeLessThan(14);
  }
  // A paragraph still gets its own handle.
  const intro = await hover(page, para(main, 'Intro'));
  const g = await page.locator('.block-handle').first().boundingBox();
  expect(Math.abs(g!.y + g!.height / 2 - (intro.y + intro.height / 2))).toBeLessThan(14);

  // Other boxes have a handle too.
  await other.locator('.ProseMirror').click();
  const sub = await hover(page, para(other, 'Other sub'));
  const og = await page.locator('.block-handle').first().boundingBox();
  expect(og, 'a handle in a box that is not the main one').not.toBeNull();
  expect(Math.abs(og!.y + og!.height / 2 - (sub.y + sub.height / 2))).toBeLessThan(14);
  if (process.env.E2E_SHOTS) {
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${process.env.E2E_SHOTS}/outline-handle.png` });
  }
});

test('dragging a point moves its sub-points with it', async ({ page, context, request }) => {
  const user = await createUser(request, 'Drew Dragger');
  await signInContext(context, user);
  await openOutline(page, request, user);
  const main = page.locator('.canvas-box').first();
  await main.locator('.ProseMirror').click();
  expect(await shape(main)).toEqual(['Point one', '  Sub 1a', '  Sub 1b', '    Deep 1b-i', 'Point two', 'Point three', '  Sub 3a']);

  /** Drag the handle that appears beside `from` to just below `to`'s line, at the list's own level. */
  const drag = async (from: string, to: string, below = true) => {
    await hover(page, para(main, from));
    const grip = await page.locator('.block-handle [data-drag-handle]').first().boundingBox();
    if (!grip) throw new Error('no grip');
    const target = await para(main, to).boundingBox();
    if (!target) throw new Error('no target');
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x + grip.width / 2 + 5, grip.y + grip.height / 2 + 5, { steps: 3 });
    await page.mouse.move(target.x + 40, target.y + (below ? target.height - 2 : 2), { steps: 10 });
    await page.mouse.up();
  };

  // "Point one", with its three sub-levels, goes below "Point two".
  await drag('Point one', 'Point two');
  expect(await shape(main)).toEqual(['Point two', 'Point one', '  Sub 1a', '  Sub 1b', '    Deep 1b-i', 'Point three', '  Sub 3a']);

  // A point with no sub-points moves alone.
  await drag('Point two', 'Point three', false);
  expect((await shape(main)).filter((l) => !l.startsWith(' '))).toHaveLength(3);
  expect(await shape(main)).toContain('  Sub 3a');

  // It persists.
  await page.waitForTimeout(1500);
  await page.reload();
  await expect(page.locator('.canvas-box:not(.is-ready)')).toHaveCount(2);
  expect(await shape(page.locator('.canvas-box').first())).toContain('    Deep 1b-i');
});

test('on a list line: + adds a new line of that list below it; the tick turns just that line into a task', async ({ page, context, request }) => {
  const user = await createUser(request, 'Lena Line');
  await signInContext(context, user);
  await openOutline(page, request, user);
  const main = page.locator('.canvas-box').first();
  await main.locator('.ProseMirror').click();

  // "+" below "Sub 1a": a new point at the same level, ready to type in.
  await hover(page, para(main, 'Sub 1a'));
  await page.getByRole('button', { name: 'Insert a block below' }).first().click();
  await page.keyboard.press('Escape'); // the slash menu it opens
  await page.keyboard.press('Backspace'); // the "/"
  await page.keyboard.type('Sub 1a and a half');
  expect(await shape(main)).toEqual(['Point one', '  Sub 1a', '  Sub 1a and a half', '  Sub 1b', '    Deep 1b-i', 'Point two', 'Point three', '  Sub 3a']);

  // The tick on "Sub 1b" converts that line only: the point nested under it stays.
  await hover(page, para(main, 'Sub 1b'));
  await page.getByRole('button', { name: 'Turn this line into a task' }).first().click();
  await expect(main.locator('.task-ref')).toHaveCount(1);
  await expect(main.locator('li', { hasText: 'Deep 1b-i' }).first()).toBeVisible();
});
