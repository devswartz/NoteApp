// Priority 5: dashboard views (Today/Upcoming/Calendar/Completed/All), filters, quick add parsing.
import { expect, test } from '@playwright/test';
import { createTask, createUser, isoDay, listTasks, signInContext, taskRow, tasksUrl, eventually } from './helpers.ts';

test.describe('dashboard', () => {
  test('Today shows overdue + today; Upcoming shows the future; Completed shows done tasks', async ({ page, context, request }) => {
    const user = await createUser(request, 'Victor Views');
    await createTask(request, user, user.wsId, { title: 'Overdue thing', dueDate: isoDay(-2) });
    await createTask(request, user, user.wsId, { title: 'Due today thing', dueDate: isoDay(0) });
    await createTask(request, user, user.wsId, { title: 'Next week thing', dueDate: isoDay(3) });
    await createTask(request, user, user.wsId, { title: 'Someday thing', dueDate: null });
    const done = await createTask(request, user, user.wsId, { title: 'Finished thing', dueDate: isoDay(0) });
    await request.fetch(`/api/tasks/${done.id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${user.token}`, 'content-type': 'application/json' },
      data: JSON.stringify({ status: 'done' }),
    });
    await signInContext(context, user);

    await page.goto(tasksUrl(user.wsId, 'today'));
    await expect(page.getByRole('heading', { name: 'Today', level: 1 })).toBeVisible();
    await expect(page.locator('.group-title.danger')).toContainText('Overdue');
    await expect(taskRow(page, 'Overdue thing')).toBeVisible();
    await expect(taskRow(page, 'Due today thing')).toBeVisible();
    await expect(taskRow(page, 'Next week thing')).toHaveCount(0);
    await expect(taskRow(page, 'Finished thing')).toHaveCount(0);

    await page.getByRole('link', { name: 'Upcoming' }).click();
    await expect(taskRow(page, 'Next week thing')).toBeVisible();
    await expect(taskRow(page, 'Someday thing')).toHaveCount(0);

    await page.getByRole('link', { name: 'Completed' }).click();
    await expect(taskRow(page, 'Finished thing')).toBeVisible();
    await expect(taskRow(page, 'Due today thing')).toHaveCount(0);

    await page.getByRole('link', { name: 'My Tasks' }).click();
    await expect(taskRow(page, 'Someday thing')).toBeVisible();
  });

  test('Calendar shows tasks on their due day', async ({ page, context, request }) => {
    const user = await createUser(request, 'Cal Endar');
    await createTask(request, user, user.wsId, { title: 'Calendar today item', dueDate: isoDay(0) });
    await signInContext(context, user);
    await page.goto(tasksUrl(user.wsId, 'calendar'));
    await expect(page.locator('.cal-day.is-today')).toContainText('Calendar today item');

    // Add from a calendar day pre-fills that date.
    await page.locator('.cal-day.is-today').hover();
    await page.locator('.cal-day.is-today').getByRole('button', { name: 'Add task', exact: true }).click({ force: true }); // hover-revealed
    const qa = page.getByRole('dialog', { name: 'Quick add task' });
    await expect(qa.locator('.qa-chips')).toContainText('Today');
    await qa.locator('.qa-input').fill('Added from calendar');
    await qa.getByRole('button', { name: 'Add task' }).click();
    await expect(page.locator('.cal-day.is-today')).toContainText('Added from calendar');
  });

  test('All Tasks: text filter, priority filter, source filter', async ({ page, context, request }) => {
    const user = await createUser(request, 'Fil Ter');
    await createTask(request, user, user.wsId, { title: 'Alpha urgent', priority: 1 });
    await createTask(request, user, user.wsId, { title: 'Beta relaxed', priority: 4 });
    await createTask(request, user, user.wsId, { title: 'Gamma medium', priority: 2 });
    await signInContext(context, user);
    await page.goto(tasksUrl(user.wsId, 'all'));
    await expect(taskRow(page, 'Alpha urgent')).toBeVisible();

    await page.getByPlaceholder('Filter tasks…').fill('beta');
    await expect(taskRow(page, 'Beta relaxed')).toBeVisible();
    await expect(taskRow(page, 'Alpha urgent')).toHaveCount(0);
    await page.getByPlaceholder('Filter tasks…').fill('');

    await page.getByRole('button', { name: /Filters/ }).click();
    await page.locator('.filters').getByLabel('Priority').selectOption('1');
    await expect(taskRow(page, 'Alpha urgent')).toBeVisible();
    await expect(taskRow(page, 'Gamma medium')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Filters · 1/ })).toBeVisible();
    await page.getByRole('button', { name: 'Clear' }).click();
    await expect(taskRow(page, 'Gamma medium')).toBeVisible();

    // (A new personal workspace is seeded with an onboarding note that has tasks in it.)
    await page.locator('.filters').getByLabel('Source').selectOption('notes');
    await expect(taskRow(page, 'Alpha urgent')).toHaveCount(0);
    await page.locator('.filters').getByLabel('Source').selectOption('standalone');
    await expect(taskRow(page, 'Alpha urgent')).toBeVisible();
  });

  test('quick add parses date, priority, recurrence and assignee', async ({ page, context, request }) => {
    const user = await createUser(request, 'Quinn Quick');
    await signInContext(context, user);
    await page.goto(tasksUrl(user.wsId, 'today'));
    await expect(page.getByRole('heading', { name: 'Today', level: 1 })).toBeVisible();

    await page.keyboard.press('q');
    const qa = page.getByRole('dialog', { name: 'Quick add task' });
    await qa.locator('.qa-input').fill('Pay rent tomorrow p1 every month @me');
    await expect(qa.locator('.qa-chips')).toContainText('Tomorrow');
    await expect(qa.locator('.qa-chips')).toContainText('P1');
    await expect(qa.locator('.qa-chips')).toContainText(/month/i);
    await expect(qa.locator('.qa-chips')).toContainText('Me');
    await qa.locator('.qa-input').press('Enter');
    await expect(qa).toHaveCount(0);

    await eventually(
      () => listTasks(request, user),
      (ts) => {
        const t = ts.find((x) => x.title === 'Pay rent') as (typeof ts)[number] & { priority?: number; recurrence?: unknown };
        return !!t && t.dueDate === isoDay(1) && t.priority === 1 && !!t.recurrence && t.assigneeId === user.id;
      },
      'parsed fields saved',
    );
    await page.getByRole('link', { name: 'Upcoming' }).click();
    await expect(taskRow(page, 'Pay rent')).toBeVisible();

    // Ctrl/⌘+Enter adds and keeps the dialog open for the next one.
    await page.keyboard.press('q');
    await qa.locator('.qa-input').fill('First of many');
    await qa.locator('.qa-input').press('ControlOrMeta+Enter');
    await expect(qa.locator('.qa-input')).toHaveValue('');
    await qa.locator('.qa-input').fill('Second of many');
    await qa.locator('.qa-input').press('Enter');
    await page.getByRole('link', { name: 'My Tasks' }).click();
    await expect(taskRow(page, 'First of many')).toBeVisible();
    await expect(taskRow(page, 'Second of many')).toBeVisible();
  });

  test('inline "Add task" in a dashboard group inherits the group date', async ({ page, context, request }) => {
    const user = await createUser(request, 'Ian Inline');
    await signInContext(context, user);
    await page.goto(tasksUrl(user.wsId, 'today'));
    await page.locator('.inline-add').first().click();
    await page.getByPlaceholder(/Task name/).fill('Inline dashboard task');
    await page.getByPlaceholder(/Task name/).press('Enter');
    await expect(taskRow(page, 'Inline dashboard task')).toBeVisible();
    await eventually(() => listTasks(request, user), (ts) => ts.find((t) => t.title === 'Inline dashboard task')?.dueDate === isoDay(0), 'due today');
  });
});
