// Dashboard keyboard workflow and bulk actions (Tasks PR #16).
import { expect, test } from '@playwright/test';
import { createTask, createUser, eventually, isoDay, listTasks, ribbon, signInContext, taskRow, tasksUrl } from './helpers.ts';

test.describe('bulk task actions', () => {
  test('Ctrl/⌘-click and Shift-click select rows; bulk complete and set priority', async ({ page, context, request }) => {
    const user = await createUser(request, 'Bulk Betty');
    for (const t of ['Bulk A', 'Bulk B', 'Bulk C', 'Bulk D']) await createTask(request, user, user.wsId, { title: t, dueDate: isoDay(1) });
    await signInContext(context, user);
    await page.goto(tasksUrl(user.wsId, 'all'));
    await ribbon(page).getByRole('button', { name: 'Sort' }).click();
    await page.getByRole('menuitem', { name: 'Name' }).click();
    await expect(taskRow(page, 'Bulk D')).toBeVisible();

    await taskRow(page, 'Bulk A').locator('.task-title').click({ modifiers: ['ControlOrMeta'] });
    await taskRow(page, 'Bulk C').locator('.task-title').click({ modifiers: ['Shift'] });
    const bar = page.getByRole('toolbar', { name: 'Bulk actions' });
    await expect(bar).toContainText('3 selected');
    // Rows are plain containers (no interactive role), so selection is a class, not aria-selected.
    await expect(taskRow(page, 'Bulk B')).toHaveClass(/\bis-selected\b/);
    await expect(taskRow(page, 'Bulk D')).not.toHaveClass(/\bis-selected\b/);

    await bar.getByRole('button', { name: 'Set priority', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Priority 1' }).click();
    await eventually(
      () => listTasks(request, user),
      (ts) => ['Bulk A', 'Bulk B', 'Bulk C'].every((n) => (ts.find((t) => t.title === n) as { priority?: number } | undefined)?.priority === 1),
      'priority set on all three',
    );

    // Selection survives the update; complete all three.
    await expect(bar).toContainText('3 selected');
    await bar.getByRole('button', { name: /Complete/ }).click();
    await eventually(
      () => listTasks(request, user),
      (ts) => ['Bulk A', 'Bulk B', 'Bulk C'].every((n) => ts.find((t) => t.title === n)?.status === 'done') && ts.find((t) => t.title === 'Bulk D')?.status === 'open',
      'three completed, D untouched',
    );
    await expect(bar).toHaveCount(0);
  });

  test('Escape clears the selection; bulk delete asks first', async ({ page, context, request }) => {
    const user = await createUser(request, 'Del Bulk');
    for (const t of ['Trash 1', 'Trash 2', 'Keep 3']) await createTask(request, user, user.wsId, { title: t });
    await signInContext(context, user);
    await page.goto(tasksUrl(user.wsId, 'all'));
    await taskRow(page, 'Trash 1').locator('.task-title').click({ modifiers: ['ControlOrMeta'] });
    const bar = page.getByRole('toolbar', { name: 'Bulk actions' });
    await expect(bar).toContainText('1 selected');
    await page.keyboard.press('Escape');
    await expect(bar).toHaveCount(0);

    await taskRow(page, 'Trash 1').locator('.task-title').click({ modifiers: ['ControlOrMeta'] });
    await taskRow(page, 'Trash 2').locator('.task-title').click({ modifiers: ['ControlOrMeta'] });
    page.once('dialog', (d) => void d.accept());
    await bar.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(taskRow(page, 'Trash 1')).toHaveCount(0);
    await expect(taskRow(page, 'Trash 2')).toHaveCount(0);
    await expect(taskRow(page, 'Keep 3')).toBeVisible();
    await eventually(() => listTasks(request, user), (ts) => !ts.some((t) => t.title.startsWith('Trash')), 'deleted on server');
  });

  test('row keys: number keys set priority, x completes', async ({ page, context, request }) => {
    const user = await createUser(request, 'Kai Keys');
    await createTask(request, user, user.wsId, { title: 'Keyboard task', dueDate: isoDay(0) });
    await signInContext(context, user);
    await page.goto(tasksUrl(user.wsId, 'today'));
    // The row's focusable control is its title button (J/K move between them).
    const title = taskRow(page, 'Keyboard task').locator('.task-title-btn');
    await title.focus();
    await page.keyboard.press('2');
    await eventually(() => listTasks(request, user), (ts) => (ts.find((t) => t.title === 'Keyboard task') as { priority?: number } | undefined)?.priority === 2, 'priority 2');
    await title.focus();
    await page.keyboard.press('x');
    await eventually(() => listTasks(request, user), (ts) => ts.find((t) => t.title === 'Keyboard task')?.status === 'done', 'completed with x');
  });
});
