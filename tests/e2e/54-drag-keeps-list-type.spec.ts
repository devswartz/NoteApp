// Dragging a list item with the grip keeps its list's type: a numbered item dropped below its list, between paragraphs or after another
// numbered list stays numbered (and joins an adjacent list of its type, numbering on); a bullet stays a bullet. Its sub-items travel with it.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { api, createPage, createUser, openPage, signInContext } from './helpers.ts';

type J = Record<string, unknown>;
const p = (t: string): J => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });
const li = (t: string, ...kids: J[]): J => ({ type: 'listItem', content: [p(t), ...kids] });
const ul = (...items: J[]): J => ({ type: 'bulletList', content: items });
const ol = (...items: J[]): J => ({ type: 'orderedList', attrs: { start: 1 }, content: items });

async function open(page: Page, request: Parameters<typeof createPage>[0], user: Awaited<ReturnType<typeof createUser>>, content: J[]) {
  const { pageId: scratch, sectionId } = await createPage(request, user, { notebook: 'Drag types', page: 'Scratch' });
  const doc = { type: 'doc', content: [{ type: 'canvasBox', attrs: { x: 0, y: 0, w: 600, z: 1, wide: true }, content }] };
  await api(request, 'POST', `/pages/${scratch}/templates`, user.token, { name: 'Types template', kind: 'canvas', content: doc });
  const { id } = await api<{ id: string }>(request, 'POST', `/sections/${sectionId}/pages`, user.token, { title: 'Types' });
  await openPage(page, user.wsId, id);
  await page.getByTestId('user-templates').locator('.template-card', { hasText: 'Types template' }).click();
  await expect(page.locator('.canvas-box:not(.is-ready)')).toHaveCount(1);
}

/** The box as text lines: paragraphs as they are, list lines as "1. text" / "- text" with two spaces per level (numbers are the real ones). */
const shape = (box: Locator) =>
  box.locator('.ProseMirror').evaluate((root) => {
    const out: string[] = [];
    const walk = (el: Element, depth: number) => {
      for (const child of Array.from(el.children)) {
        if (child.tagName === 'UL' || child.tagName === 'OL') {
          const ordered = child.tagName === 'OL';
          const start = ordered ? Number((child as HTMLOListElement).start || 1) : 0;
          Array.from(child.children).forEach((item, i) => {
            out.push(`${'  '.repeat(depth)}${ordered ? `${start + i}.` : '-'} ${item.querySelector(':scope > p')?.textContent ?? ''}`);
            walk(item, depth + 1);
          });
        } else if (child.tagName === 'P' && depth === 0 && child.textContent) out.push(child.textContent);
      }
    };
    walk(root, 0);
    return out;
  });

const line = (box: Locator, t: string) => box.locator('p', { hasText: new RegExp(`^${t}$`) }).first();

/** Drag the grip of the line `from` to just above (or below) the line `to`. */
async function drag(page: Page, box: Locator, from: string, to: string, below = false) {
  const b = (await line(box, from).boundingBox())!;
  await page.mouse.move(b.x + 30, b.y + b.height / 2, { steps: 6 });
  await page.waitForTimeout(300);
  const grip = (await page.locator('.block-handle [data-drag-handle]').first().boundingBox())!;
  const t = (await line(box, to).boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 + 5, grip.y + grip.height / 2 + 5, { steps: 3 });
  await page.mouse.move(below ? t.x + t.width - 10 : t.x + 40, t.y + (below ? t.height - 2 : -2), { steps: 12 }); // (the drop goes after a block when the pointer is in its second half)
  await page.mouse.up();
  await page.waitForTimeout(300);
}

async function setup(page: Page, context: Parameters<typeof signInContext>[0], request: Parameters<typeof createPage>[0], name: string, content: J[]) {
  const user = await createUser(request, name);
  await signInContext(context, user);
  await open(page, request, user, content);
  const box = page.locator('.canvas-box').first();
  await box.locator('.ProseMirror').click();
  return box;
}

const numbered = () => ol(li('One'), li('Two', ol(li('a child'), li('b child'))), li('Three'));

test('a numbered item with its sub-items, dropped below its list, stays numbered with its children intact', async ({ page, context, request }) => {
  const box = await setup(page, context, request, 'Drop below', [p('Before'), numbered(), p('After the list')]);
  expect(await shape(box)).toEqual(['Before', '1. One', '2. Two', '  1. a child', '  2. b child', '3. Three', 'After the list']);
  await drag(page, box, 'Two', 'After the list');
  const after = await shape(box);
  expect(after, 'no bullets: it is still a numbered item').not.toContain('- Two');
  expect(after).toEqual(['Before', '1. One', '2. Three', '3. Two', '  1. a child', '  2. b child', 'After the list']);
});

test('dropped between two paragraphs it becomes a numbered list of its own, children intact', async ({ page, context, request }) => {
  const box = await setup(page, context, request, 'Drop between', [numbered(), p('First paragraph'), p('Second paragraph')]);
  await drag(page, box, 'Two', 'First paragraph', true);
  expect(await shape(box)).toEqual(['1. One', '2. Three', 'First paragraph', '1. Two', '  1. a child', '  2. b child', 'Second paragraph']);
});

test('dropped right after another numbered list it joins it and the numbering continues', async ({ page, context, request }) => {
  const box = await setup(page, context, request, 'Drop join', [ol(li('Alpha'), li('Beta')), p('Gap'), numbered()]);
  await drag(page, box, 'Two', 'Gap');
  expect(await shape(box)).toEqual(['1. Alpha', '2. Beta', '3. Two', '  1. a child', '  2. b child', 'Gap', '1. One', '2. Three']);
});

test('a bullet item dropped below its list stays a bullet', async ({ page, context, request }) => {
  const box = await setup(page, context, request, 'Drop bullet', [p('Before'), ul(li('Pea'), li('Quince', ul(li('child'))), li('Rue')), p('After the bullets')]);
  await drag(page, box, 'Quince', 'After the bullets');
  const after = await shape(box);
  expect(after).toEqual(['Before', '- Pea', '- Rue', '- Quince', '  - child', 'After the bullets']);
});

test('dropped inside a list of another type it becomes an item of that list', async ({ page, context, request }) => {
  const box = await setup(page, context, request, 'Drop other', [numbered(), ul(li('Bullet one'), li('Bullet two'))]);
  await drag(page, box, 'Two', 'Bullet two');
  const after = await shape(box);
  expect(after.some((l) => l.endsWith('Two')), 'Two is in the bullet list as a bullet').toBe(true);
  expect(after).toContain('- Two');
});
