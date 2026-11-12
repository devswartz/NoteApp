// The ⋮⋮ handle of a nested list line stays on that line while the pointer travels left to it: crossing the parent's indent used to
// retarget the handle to the parent item, so only top-level lines could be dragged. Three nesting levels, wide and narrow boxes.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { api, createPage, createUser, openPage, signInContext } from './helpers.ts';

type J = Record<string, unknown>;
const p = (t: string): J => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });
const li = (t: string, ...kids: J[]): J => ({ type: 'listItem', content: [p(t), ...kids] });
const ul = (...items: J[]): J => ({ type: 'bulletList', content: items });

/** Level 1 "Alpha" > level 2 "Beta" > level 3 "Gamma" (with a level-4 child "Delta"), then "Omega" at level 1. */
const list = () => ul(li('Alpha', ul(li('Beta', ul(li('Gamma', ul(li('Delta'))), li('Gamma sibling'))), li('Beta sibling'))), li('Omega'));

async function open(page: Page, request: Parameters<typeof createPage>[0], user: Awaited<ReturnType<typeof createUser>>, width: number) {
  const { pageId: scratch, sectionId } = await createPage(request, user, { notebook: 'Reach', page: 'Scratch' });
  const content = { type: 'doc', content: [{ type: 'canvasBox', attrs: { x: 0, y: 0, w: width, z: 1, wide: width > 500 }, content: [list()] }] };
  await api(request, 'POST', `/pages/${scratch}/templates`, user.token, { name: 'Reach template', kind: 'canvas', content });
  const { id } = await api<{ id: string }>(request, 'POST', `/sections/${sectionId}/pages`, user.token, { title: 'Reach' });
  await openPage(page, user.wsId, id);
  await page.getByTestId('user-templates').locator('.template-card', { hasText: 'Reach template' }).click();
  await expect(page.locator('.canvas-box:not(.is-ready)')).toHaveCount(1);
}

const para = (box: Locator, t: string) => box.locator('p', { hasText: new RegExp(`^${t}$`) }).first();
const shape = (box: Locator) =>
  box.locator('li > p').evaluateAll((ps) =>
    ps.map((q) => {
      let depth = 0;
      for (let e = q.parentElement; e; e = e.parentElement) if (e.tagName === 'LI') depth++;
      return `${'  '.repeat(depth - 1)}${q.textContent}`;
    }),
  );
const mid = (b: { y: number; height: number }) => b.y + b.height / 2;

for (const [label, width] of [['wide', 640], ['narrow', 260]] as const) {
  test(`a level-3 line keeps its handle on the way to it, and drags with its children (${label} box)`, async ({ page, context, request }) => {
    const user = await createUser(request, `Reach ${label}`);
    await signInContext(context, user);
    await open(page, request, user, width);
    const box = page.locator('.canvas-box').first();
    await box.locator('.ProseMirror').click();
    expect(await shape(box)).toEqual(['Alpha', '  Beta', '    Gamma', '      Delta', '    Gamma sibling', '  Beta sibling', 'Omega']);

    // Each of the three levels (and the level-4 line): point at its text, then walk left in small steps to the handle.
    for (const t of ['Beta', 'Gamma', 'Delta']) {
      const line = (await para(box, t).boundingBox())!;
      const y = mid(line);
      await page.mouse.move(line.x + 30, y, { steps: 5 });
      await page.waitForTimeout(250);
      const grip = (await page.locator('.block-handle [data-drag-handle]').first().boundingBox())!;
      expect(grip, `${t}: handle shown`).not.toBeNull();
      expect(Math.abs(mid(grip) - y), `${t}: handle beside its line`).toBeLessThan(14);
      for (let x = line.x + 30; x > grip.x + grip.width / 2; x -= 4) {
        await page.mouse.move(x, y);
        const g = (await page.locator('.block-handle [data-drag-handle]').first().boundingBox())!;
        expect(Math.abs(mid(g) - y), `${t}: handle still beside its own line at x=${Math.round(x)}`).toBeLessThan(14);
      }
      await page.mouse.move(grip.x + grip.width / 2, mid(grip));
      const g = (await page.locator('.block-handle [data-drag-handle]').first().boundingBox())!;
      expect(Math.abs(mid(g) - y), `${t}: handle reached`).toBeLessThan(14);
    }

    // Drag the level-3 line "Gamma" (with its child "Delta") below "Omega", to the top level.
    const gamma = (await para(box, 'Gamma').boundingBox())!;
    await page.mouse.move(gamma.x + 30, mid(gamma), { steps: 5 });
    await page.waitForTimeout(250);
    const grip = (await page.locator('.block-handle [data-drag-handle]').first().boundingBox())!;
    for (let x = gamma.x + 30; x > grip.x + grip.width / 2; x -= 4) await page.mouse.move(x, mid(gamma));
    await page.mouse.move(grip.x + grip.width / 2, mid(grip));
    const omega = (await para(box, 'Omega').boundingBox())!;
    await page.mouse.down();
    await page.mouse.move(grip.x + grip.width / 2 + 5, mid(grip) + 5, { steps: 3 });
    await page.mouse.move(omega.x + 40, omega.y + omega.height - 2, { steps: 10 });
    await page.mouse.up();
    const after = await shape(box);
    expect(after.indexOf('Gamma'), 'Gamma left its parent').toBeGreaterThan(after.indexOf('Omega'));
    expect(after[after.indexOf('Gamma') + 1], 'its child went with it').toBe('  Delta');
    expect(after).toContain('    Gamma sibling'); // the line next to it stayed where it was, at level 3
    expect(after.at(-2)).toBe('Gamma'); // and Gamma is now at the top level, with Delta under it
    expect(after).toHaveLength(7);
  });
}

test('moving to a different row retargets the handle as usual', async ({ page, context, request }) => {
  const user = await createUser(request, 'Reach rows');
  await signInContext(context, user);
  await open(page, request, user, 640);
  const box = page.locator('.canvas-box').first();
  await box.locator('.ProseMirror').click();
  const beta = (await para(box, 'Beta').boundingBox())!;
  const omega = (await para(box, 'Omega').boundingBox())!;
  await page.mouse.move(beta.x + 30, mid(beta), { steps: 5 });
  await page.waitForTimeout(250);
  await page.mouse.move(beta.x - 20, mid(beta), { steps: 4 }); // in the gutter beside Beta
  await page.waitForTimeout(100);
  await page.mouse.move(omega.x - 20, mid(omega), { steps: 8 }); // down to another row's gutter
  await page.waitForTimeout(250);
  const grip = (await page.locator('.block-handle [data-drag-handle]').first().boundingBox())!;
  expect(Math.abs(mid(grip) - mid(omega)), 'the handle is beside Omega now').toBeLessThan(14);
});
