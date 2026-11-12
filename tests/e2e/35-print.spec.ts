// Printing (src/print/): Ctrl/Cmd+P and the ribbon print the open page laid out for paper:
// app chrome hidden, canvas boxes in reading order as a flow (side-by-side boxes as columns),
// tasks as compact checkboxes, no page colour by default. "Print section" prints every page of
// a section and its subsections in tree order; "Print selection" prints selected text or Ctrl+clicked boxes. window.print is stubbed: the checks run on the
// print media layout. With PRINT_SAMPLES=1 the sample note is saved as A4 and Letter PDFs in
// docs/screens/.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { api, createPage, createTask, createUser, isoDay, listTasks, openPage, ribbon, signInContext, type TestUser } from './helpers.ts';

type J = Record<string, unknown>;
const text = (t: string, marks?: J[]): J => ({ type: 'text', text: t, ...(marks ? { marks } : {}) });
const p = (...c: J[]): J => ({ type: 'paragraph', content: c });
const h = (level: number, t: string): J => ({ type: 'heading', attrs: { level }, content: [text(t)] });
const ul = (...items: string[]): J => ({ type: 'bulletList', content: items.map((i) => ({ type: 'listItem', content: [p(text(i))] })) });
const box = (x: number, y: number, w: number, content: J[], wide = false): J => ({ type: 'canvasBox', attrs: { x, y, w, z: 1, ...(wide ? { wide: true } : {}) }, content });
const cell = (t: string, header = false): J => ({ type: header ? 'tableHeader' : 'tableCell', content: [p(text(t))] });

/** Stub the native dialog: count calls instead. */
async function stubPrint(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __printed: number }).__printed = 0;
    window.print = () => {
      (window as unknown as { __printed: number }).__printed++;
    };
  });
}
const printed = (page: Page) => page.evaluate(() => (window as unknown as { __printed: number }).__printed);

/** A realistic note: a wide main box (headings, list, tasks, table, code, callout) and two boxes side by side under it. */
async function samplePage(request: APIRequestContext, page: Page, user: TestUser) {
  const { pageId: scratch, sectionId } = await createPage(request, user, { notebook: 'Project Atlas', page: 'Scratch' });
  const t1 = await createTask(request, user, user.wsId, { title: 'Draft the Q3 budget', priority: 1 });
  const t2 = await createTask(request, user, user.wsId, { title: 'Book the offsite venue', priority: 2 });
  const t3 = await createTask(request, user, user.wsId, { title: 'Send last week’s minutes', priority: 4 });
  const ref = (id: string): J => ({ type: 'taskRef', attrs: { taskId: id } });
  const content = {
    type: 'doc',
    content: [
      box(0, 0, 686, [
        h(2, 'Agenda'),
        p(text('Kick-off for the '), text('Atlas', [{ type: 'bold' }]), text(' launch. '), text('Budget is the blocker', [{ type: 'highlight', attrs: { color: 'yellow' } }]), text(' — see '), text('the brief', [{ type: 'link', attrs: { href: 'https://example.com/atlas-brief' } }]), text('.')),
        ul('Status of each workstream', 'Risks and owners', 'Dates for the beta'),
        h(3, 'Action items'),
        ref(t1.id),
        ref(t2.id),
        ref(t3.id),
        h(3, 'Timeline'),
        { type: 'table', content: [{ type: 'tableRow', content: [cell('Milestone', true), cell('Owner', true), cell('Date', true)] }, { type: 'tableRow', content: [cell('Design freeze'), cell('Mia'), cell('3 Dec')] }, { type: 'tableRow', content: [cell('Beta'), cell('Leo'), cell('15 Jan')] }] },
        { type: 'codeBlock', attrs: { language: 'bash' }, content: [text('npm run release -- --channel beta --notes "Atlas beta: first public build with the new onboarding flow and sync engine"')] },
        { type: 'callout', attrs: { emoji: '💡' }, content: [p(text('Keep the beta small: 50 teams, hand-picked.'))] },
      ], true),
      box(0, 1600, 420, [h(3, 'Notes'), p(text('Marketing wants the launch post a week before the beta. Support needs the FAQ by then too.'))]),
      box(460, 1600, 380, [h(3, 'Decisions'), { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false }, content: [p(text('Ship behind a flag'))] }, { type: 'taskItem', attrs: { checked: false }, content: [p(text('No pricing change'))] }] }]),
    ],
  };
  await api(request, 'POST', `/pages/${scratch}/templates`, user.token, { name: 'Print sample', kind: 'canvas', content });
  const { id: pageId } = await api<{ id: string }>(request, 'POST', `/sections/${sectionId}/pages`, user.token, { title: 'Weekly planning' });

  await openPage(page, user.wsId, pageId);
  await page.getByTestId('user-templates').locator('.template-card', { hasText: 'Print sample' }).click();
  await expect(page.locator('.canvas-box:not(.is-ready)')).toHaveCount(3);
  // The template made fresh tasks on this page: give them dates, and finish one.
  await expect.poll(async () => (await listTasks(request, user)).filter((t) => t.pageId === pageId).length).toBe(3);
  for (const t of (await listTasks(request, user)).filter((x) => x.pageId === pageId)) {
    const patch = t.title.startsWith('Draft') ? { dueDate: isoDay(3) } : t.title.startsWith('Send') ? { status: 'done' } : { dueDate: isoDay(10) };
    await api(request, 'PATCH', `/tasks/${t.id}`, user.token, patch);
  }
  await expect(page.locator('.task-ref')).toHaveCount(3);
  return { pageId, sectionId };
}

test('Ctrl+P prints the open page laid out for paper', async ({ page, context, request }) => {
  const user = await createUser(request, 'Pria Print');
  await signInContext(context, user);
  await stubPrint(page);
  await samplePage(request, page, user);

  // A page colour is set, but it doesn't print unless asked.
  await ribbon(page).getByRole('button', { name: 'Page colour' }).click();
  await page.getByRole('button', { name: 'Page colour: Yellow' }).click();

  await page.locator('.canvas-box', { hasText: 'Agenda' }).locator('.ProseMirror').click();
  await page.keyboard.press('ControlOrMeta+p');
  await expect.poll(() => printed(page)).toBe(1);

  await page.emulateMedia({ media: 'print' });
  await page.setViewportSize({ width: 794, height: 1123 }); // A4 at 96 dpi
  const root = page.locator('#print-root');
  await expect(root).toBeVisible();
  // App chrome is gone.
  await expect(page.locator('.ribbon')).toBeHidden();
  await expect(page.getByRole('navigation', { name: 'Sidebar' })).toBeHidden();
  await expect(page.getByTestId('canvas-surface')).toBeHidden();

  await expect(root.locator('.print-title')).toHaveText('Weekly planning');
  await expect(root.locator('.print-sub')).toContainText('Project Atlas › General');
  // Reading order: the main box, then the two side-by-side boxes as one row of columns, left to right.
  const rows = root.locator('.print-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Agenda');
  await expect(rows.nth(1)).toHaveClass(/is-columns/);
  await expect(rows.nth(1).locator('.print-box')).toHaveText([/Notes/, /Decisions/]);
  // Nothing is clipped or wider than the paper.
  const overflow = await root.evaluate((el) => {
    const bad = [...el.querySelectorAll<HTMLElement>('.print-box, .print-box pre, .print-box table')].filter((n) => n.scrollWidth > n.clientWidth + 1).length;
    return { bad, wide: el.scrollWidth > document.documentElement.clientWidth };
  });
  expect(overflow).toEqual({ bad: 0, wide: false });
  // Tasks: a compact checkbox line with due date, assignee and priority; done ones struck through.
  const tasks = root.locator('.print-task');
  await expect(tasks).toHaveCount(3);
  await expect(tasks.filter({ hasText: 'Draft the Q3 budget' }).locator('.print-task-meta')).toContainText('Pria Print');
  await expect(tasks.filter({ hasText: 'Draft the Q3 budget' }).locator('.print-task-meta')).toContainText('P1');
  await expect(tasks.filter({ hasText: 'minutes' })).toHaveClass(/is-done/);
  // No page colour unless "Print page colour" is on.
  await expect(root.locator('.print-page')).not.toHaveAttribute('data-page-color', /.*/);
  const bg = await root.locator('.print-page').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).toBe('rgba(0, 0, 0, 0)');

  if (process.env.PRINT_SAMPLES) {
    await page.pdf({ path: 'docs/screens/print-sample-a4.pdf', format: 'A4', printBackground: true });
    await page.pdf({ path: 'docs/screens/print-sample-letter.pdf', format: 'Letter', printBackground: true });
  }

  // The ribbon's Print does the same.
  await page.emulateMedia({ media: 'screen' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await ribbon(page).getByRole('button', { name: 'Print' }).click();
  await expect.poll(() => printed(page)).toBe(2);
});

test('Print section prints its pages and subsections in tree order, each on a new sheet', async ({ page, context, request }) => {
  const user = await createUser(request, 'Sami Section');
  const { notebookId, sectionId, pageId: alpha } = await createPage(request, user, { notebook: 'Handbook', page: 'Alpha' });
  await api(request, 'POST', `/sections/${sectionId}/pages`, user.token, { title: 'Beta' });
  const sub = await api<{ id: string }>(request, 'POST', `/notebooks/${notebookId}/sections`, user.token, { name: 'Appendix', parentId: sectionId });
  await api(request, 'POST', `/sections/${sub.id}/pages`, user.token, { title: 'Gamma' });
  await signInContext(context, user);
  await stubPrint(page);
  await openPage(page, user.wsId, alpha);
  await page.keyboard.type('First page text');

  const tree = page.getByRole('navigation', { name: 'Sidebar' }).getByRole('tree', { name: 'Sections' });
  await tree.getByText('General', { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Print…' }).click();
  await page.getByRole('dialog', { name: 'Print section' }).getByRole('button', { name: 'All pages' }).click();
  await expect.poll(() => printed(page)).toBe(1);

  await page.emulateMedia({ media: 'print' });
  const root = page.locator('#print-root');
  await expect(root.locator('.print-title')).toHaveText(['Alpha', 'Beta', 'Gamma']);
  await expect(root.locator('.print-page').nth(0)).toContainText('First page text');
  await expect(root.locator('.print-page').nth(2).locator('.print-sub')).toContainText('Handbook › General › Appendix');
  const breaks = await root.locator('.print-page').evaluateAll((els) => els.map((e) => getComputedStyle(e).breakBefore));
  expect(breaks).toEqual(['auto', 'page', 'page']);
});

/** A canvas page with these boxes (made through a template, as the sample note is). */
async function canvasPage(request: APIRequestContext, page: Page, user: TestUser, title: string, boxes: J[]) {
  const { pageId: scratch, sectionId } = await createPage(request, user, { notebook: 'Selections', page: 'Scratch' });
  await api(request, 'POST', `/pages/${scratch}/templates`, user.token, { name: `${title} template`, kind: 'canvas', content: { type: 'doc', content: boxes } });
  const { id: pageId } = await api<{ id: string }>(request, 'POST', `/sections/${sectionId}/pages`, user.token, { title });
  await openPage(page, user.wsId, pageId);
  await page.getByTestId('user-templates').locator('.template-card', { hasText: `${title} template` }).click();
  await expect(page.locator('.canvas-box:not(.is-ready)')).toHaveCount(boxes.length);
  return pageId;
}

const ol = (...items: string[]): J => ({ type: 'orderedList', attrs: { start: 1 }, content: items.map((i) => ({ type: 'listItem', content: [p(text(i))] })) });

test('Print selection prints only the selected text, under the page title, list numbers kept', async ({ page, context, request }) => {
  const user = await createUser(request, 'Selma Select');
  await signInContext(context, user);
  await stubPrint(page);
  await canvasPage(request, page, user, 'Trip notes', [
    box(0, 0, 600, [p(text('Alpha intro')), p(text('Bravo bold', [{ type: 'bold' }])), ol('First step', 'Second step', 'Third step'), p(text('Zulu outro'))], true),
  ]);

  // Select from the start of "Second step" to the end of "Third step".
  const box1 = page.locator('.canvas-box').first();
  await box1.locator('li', { hasText: 'Second step' }).locator('p').click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+End');
  await expect(ribbon(page).getByRole('button', { name: 'Print selection', exact: true })).toBeVisible(); // the editor has taken in the selection

  // Ctrl+P asks: the selection, or the whole page.
  await page.keyboard.press('ControlOrMeta+p');
  await page.getByRole('dialog', { name: 'Print' }).getByRole('button', { name: 'Print selection' }).click();
  await expect.poll(() => printed(page)).toBe(1);

  await page.emulateMedia({ media: 'print' });
  const root = page.locator('#print-root');
  await expect(root.locator('.print-title')).toHaveText('Trip notes');
  await expect(root.locator('.print-box li')).toHaveText(['Second step', 'Third step']);
  await expect(root.locator('.print-box ol')).toHaveAttribute('start', '2');
  await expect(root).not.toContainText('First step');
  await expect(root).not.toContainText('Alpha intro');
  await expect(root).not.toContainText('Zulu outro');

  // The ribbon offers it directly too; "Whole page" in the Ctrl+P question prints everything.
  await page.emulateMedia({ media: 'screen' });
  await ribbon(page).getByRole('button', { name: 'Print selection', exact: true }).click();
  await expect.poll(() => printed(page)).toBe(2);
  await page.keyboard.press('ControlOrMeta+p');
  await page.getByRole('dialog', { name: 'Print' }).getByRole('button', { name: 'Whole page' }).click();
  await expect.poll(() => printed(page)).toBe(3);
  await page.emulateMedia({ media: 'print' });
  await expect(root).toContainText('Alpha intro');
  await expect(root).toContainText('Zulu outro');
});

test('Ctrl+click picks boxes; Print selection prints them in reading order; Escape clears', async ({ page, context, request }) => {
  const user = await createUser(request, 'Bo Boxes');
  await signInContext(context, user);
  await stubPrint(page);
  await canvasPage(request, page, user, 'Board', [
    box(0, 0, 400, [p(text('Top box text'))]),
    box(0, 300, 400, [p(text('Middle box text'))]),
    box(0, 600, 400, [p(text('Bottom box text'))]),
  ]);
  const boxOf = (t: string) => page.locator('.canvas-box', { hasText: t });
  // Ctrl/Cmd+click on the box's frame (its padding) picks the whole box; on a line of text it would pick the line.
  const FRAME = { modifiers: ['ControlOrMeta' as const], position: { x: 4, y: 12 } };

  // Picked bottom first, then top: printed top to bottom all the same.
  await boxOf('Bottom box text').click(FRAME);
  await boxOf('Top box text').click(FRAME);
  await expect(page.locator('.canvas-box.is-picked')).toHaveCount(2);
  await expect(boxOf('Top box text')).toHaveAttribute('aria-label', 'Text box, selected');
  // Ctrl+click again takes one out; once more puts it back.
  await boxOf('Top box text').click(FRAME);
  await expect(page.locator('.canvas-box.is-picked')).toHaveCount(1);
  await boxOf('Top box text').click(FRAME);
  await expect(page.locator('.canvas-box.is-picked')).toHaveCount(2);

  await ribbon(page).getByRole('button', { name: 'Print selection', exact: true }).click();
  await expect.poll(() => printed(page)).toBe(1);
  await page.emulateMedia({ media: 'print' });
  const root = page.locator('#print-root');
  await expect(root.locator('.print-title')).toHaveText('Board');
  await expect(root.locator('.print-box')).toHaveText([/Top box text/, /Bottom box text/]);
  await expect(root).not.toContainText('Middle box text');

  await page.emulateMedia({ media: 'screen' });
  await page.keyboard.press('Escape');
  await expect(page.locator('.canvas-box.is-picked')).toHaveCount(0);
  await expect(ribbon(page).getByRole('button', { name: 'Print selection', exact: true })).toHaveCount(0);

  // A plain click clears the picks too.
  await boxOf('Middle box text').click(FRAME);
  await expect(page.locator('.canvas-box.is-picked')).toHaveCount(1);
  await boxOf('Top box text').click();
  await expect(page.locator('.canvas-box.is-picked')).toHaveCount(0);
});
