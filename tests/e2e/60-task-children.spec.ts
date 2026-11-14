// Notes under a task (src/editor/taskChildren.ts): a task block holds the bullets, checklists and subtasks written
// under it, like a OneNote To Do tag. Converting keeps sub-points; Tab / Shift+Tab move lines in and out; a line
// converted in a task's notes is a subtask; the notes move with the task, stay when the task is deleted from the
// panel, show read-only in the task panel; a plain checklist's items are never tasks (only their count shows).
import { expect, test, type Page } from '@playwright/test';
import { api, createPage, createUser, eventually, firstEditor, focusEnd, listTasks, openPage, ribbon, settleCaret, signInContext, taskRef, taskRow, tasksUrl, addInlineTask } from './helpers.ts';

type T = { id: string; title: string; pageId: string | null; parentId?: string | null; checklist?: { done: number; total: number } | null };
const tasksOn = async (request: Parameters<typeof listTasks>[0], user: Parameters<typeof listTasks>[1], pageId: string) =>
  ((await listTasks(request, user)) as T[]).filter((t) => t.pageId === pageId);

/** Put the caret at the end of the line with this exact text. */
async function caretAtEnd(page: Page, text: string) {
  await firstEditor(page).getByText(text, { exact: true }).click();
  await page.keyboard.press('End');
  await settleCaret(page);
}

test('converting a bullet keeps its sub-bullets under the new task (no tasks for them)', async ({ page, context, request }) => {
  const user = await createUser(request, 'Cleo Convert');
  const { pageId } = await createPage(request, user);
  await signInContext(context, user);
  await openPage(page, user.wsId, pageId);
  await focusEnd(page);
  await page.keyboard.type('- Call vendor');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.type('ask about pricing');
  await page.keyboard.press('Enter');
  await page.keyboard.type('get a quote');
  await caretAtEnd(page, 'Call vendor');
  await page.keyboard.press('ControlOrMeta+Enter');
  const task = taskRef(page, 'Call vendor');
  await expect(task.locator('.task-ref-children li')).toHaveText(['ask about pricing', 'get a quote']);
  await eventually(() => tasksOn(request, user, pageId), (ts) => ts.length === 1 && ts[0].title === 'Call vendor', 'one task, sub-bullets stay notes');
});

test('Tab moves a line into the task above, the ribbon checkbox works there, converting it makes a subtask, Shift+Tab lifts it out', async ({ page, context, request }) => {
  const user = await createUser(request, 'Tabitha Tab');
  const { pageId } = await createPage(request, user);
  await signInContext(context, user);
  await openPage(page, user.wsId, pageId);
  const plan = await addInlineTask(page, 'Plan launch'); // leaves the caret on a plain line below it
  await page.keyboard.type('write the brief');
  await page.keyboard.press('Home');
  await page.keyboard.press('Tab');
  await expect(plan.locator('.task-ref-children')).toContainText('write the brief');
  // A plain checkbox in the task's notes (ribbon), and back.
  await ribbon(page).getByRole('button', { name: 'More list options' }).click();
  await page.getByRole('button', { name: 'Plain checkbox' }).click();
  await expect(plan.locator('.task-ref-children ul[data-type="taskList"] li p')).toHaveText(['write the brief']);
  await expect(plan.locator('.task-ref-checks')).toHaveText('0/1');
  await ribbon(page).getByRole('button', { name: 'More list options' }).click();
  await page.getByRole('button', { name: 'Plain checkbox' }).click();
  await expect(plan.locator('.task-ref-children ul[data-type="taskList"]')).toHaveCount(0);
  // Convert the note line: a real subtask, where it is.
  await caretAtEnd(page, 'write the brief');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(plan.locator('.task-ref-children .task-ref-title')).toHaveValue('write the brief');
  const planId = (await tasksOn(request, user, pageId)).find((t) => t.title === 'Plan launch')!.id;
  await eventually(() => tasksOn(request, user, pageId), (ts) => ts.find((t) => t.title === 'write the brief')?.parentId === planId, 'subtask of Plan launch');
  // Shift+Tab in the subtask's title takes it out: a task of its own again.
  await plan.locator('.task-ref-children .task-ref-title').click();
  await page.keyboard.press('Shift+Tab');
  await expect(plan.locator('.task-ref-children .task-ref')).toHaveCount(0);
  await expect(taskRef(page, 'write the brief')).toBeVisible();
  await eventually(() => tasksOn(request, user, pageId), (ts) => ts.find((t) => t.title === 'write the brief')?.parentId === null, 'top-level again');
});

test('a task moves with its notes (Alt+Shift+arrows), and deleting it from the task panel keeps the notes', async ({ page, context, request }) => {
  test.setTimeout(45_000);
  const user = await createUser(request, 'Moe Mover');
  const { pageId } = await createPage(request, user);
  await signInContext(context, user);
  await openPage(page, user.wsId, pageId);
  await focusEnd(page);
  await page.keyboard.type('Intro line');
  const task = await addInlineTask(page, 'Movable task');
  await page.keyboard.type('note under it');
  await page.keyboard.press('Home');
  await page.keyboard.press('Tab');
  await expect(task.locator('.task-ref-children')).toContainText('note under it');
  // Move the intro below the task: the task and its note go up as one block.
  await caretAtEnd(page, 'Intro line');
  await page.keyboard.press('Alt+Shift+ArrowDown');
  const order = await firstEditor(page).evaluate((el) => [...el.children].map((c) => (c.classList.contains('task-ref') || c.querySelector(':scope > .task-ref') ? 'TASK' : c.textContent?.trim())));
  expect(order.indexOf('TASK')).toBeLessThan(order.indexOf('Intro line'));
  await expect(task.locator('.task-ref-children')).toContainText('note under it');

  // Delete from the task panel: the line goes after the Undo window, the note stays where it was.
  await task.locator('.task-ref-inner').hover();
  await task.getByRole('button', { name: 'Open task details' }).click();
  await page.getByRole('button', { name: 'Delete task' }).click();
  await expect(page.locator('.task-ref')).toHaveCount(0, { timeout: 15_000 });
  await expect(firstEditor(page)).toContainText('note under it');
  await expect(firstEditor(page)).toContainText('Intro line');
});

test('a page saved before task notes existed loads as it was', async ({ page, context, request }) => {
  const user = await createUser(request, 'Olga Old');
  // The welcome page is seeded on the server with plain (childless) task blocks, as every page before this change.
  const seeded = ((await listTasks(request, user)) as T[]).find((t) => t.title.startsWith('Try checking off'))!;
  await signInContext(context, user);
  await openPage(page, user.wsId, seeded.pageId!);
  await expect(page.locator('.task-ref')).toHaveCount(3);
  await expect(page.locator('.task-ref-fold')).toHaveCount(0);
  await expect(page.locator('.task-ref.has-notes')).toHaveCount(0);
  await page.locator('.task-ref').first().locator('.task-check').click();
  await eventually(() => listTasks(request, user), (ts) => ts.some((t) => t.id === seeded.id && t.status === 'done'), 'still a live task');
});

test('“Pack for the trip”: a 25-item checklist under a task stays a checklist; only “12/25” shows in the Tasks views', async ({ page, context, request }) => {
  test.setTimeout(60_000);
  const user = await createUser(request, 'Petra Packer');
  const { pageId } = await createPage(request, user);
  await signInContext(context, user);
  await openPage(page, user.wsId, pageId);
  const task = await addInlineTask(page, 'Pack for the trip');
  await task.locator('.task-ref-inner').hover();
  await task.getByRole('button', { name: 'Add checklist under this task' }).click();
  for (let i = 1; i <= 25; i++) {
    await page.keyboard.type(`item ${i}`);
    if (i < 25) await page.keyboard.press('Enter');
  }
  const items = task.locator('.task-ref-children ul[data-type="taskList"] > li');
  await expect(items).toHaveCount(25);
  for (let i = 0; i < 12; i++) await items.nth(i).locator('label input').click();
  await expect(task.locator('.task-ref-checks')).toHaveText('12/25');
  // Fold the notes away and back.
  await task.getByRole('button', { name: 'Hide the notes under this task' }).click();
  await expect(task.locator('.task-ref-children')).toBeHidden();
  await task.getByRole('button', { name: 'Show the notes under this task' }).click();
  await expect(items.first()).toBeVisible();

  await eventually(() => tasksOn(request, user, pageId), (ts) => ts.length === 1 && ts[0].checklist?.done === 12 && ts[0].checklist?.total === 25, 'one task with a 12/25 checklist');
  // From the note: the items with their state, read-only.
  await task.locator('.task-ref-inner').hover();
  await task.getByRole('button', { name: 'Open task details' }).click();
  const notes = page.getByRole('region', { name: 'From the note' });
  await expect(notes.locator('.note-notes-line')).toHaveCount(25);
  await expect(notes.locator('.note-notes-line.is-done')).toHaveCount(12);
  await page.keyboard.press('Escape');

  await page.goto(tasksUrl(user.wsId, 'all'));
  const row = taskRow(page, 'Pack for the trip');
  await expect(row.locator('.chip-checklist')).toHaveText('12/25');
  await expect(taskRow(page, 'item 1')).toHaveCount(0);
  void api;
});
