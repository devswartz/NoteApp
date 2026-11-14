// The due-date menu's built-in month calendar (replaced <input type="date">, whose native picker
// changed the value on each month step, which set the due date and closed the menu).
import { expect, test, type Page } from '@playwright/test';
import { api, createTask, createUser, eventually, isoDay, listTasks, signInContext, taskRow, tasksUrl } from './helpers.ts';

/** YYYY-MM-DD for day `day` of the month `months` after the current (UTC) one. */
function dayInMonth(months: number, day: number) {
  const d = new Date(`${isoDay(0).slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months, day);
  return d.toISOString().slice(0, 10);
}

const dueOf = async (request: Parameters<typeof listTasks>[0], user: Parameters<typeof listTasks>[1], id: string) =>
  (await listTasks(request, user)).find((t) => t.id === id)?.dueDate ?? null;

const monthTitle = (iso: string) => new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));

async function openDueMenu(page: Page, title: string) {
  // An empty due chip shows on hover.
  await taskRow(page, title).hover();
  await taskRow(page, title).locator('.chip-due').click();
  const grid = page.locator('.popover').getByRole('grid', { name: 'Due date' });
  await expect(grid).toBeVisible();
  return grid;
}

test('month arrows only navigate; clicking a day sets the due date and closes the menu', async ({ page, context, request }) => {
  const user = await createUser(request, 'Cal Endar');
  const t = await createTask(request, user, user.wsId, { title: 'Book the venue' });
  await signInContext(context, user);
  await page.goto(tasksUrl(user.wsId, 'all'));
  await expect(taskRow(page, 'Book the venue')).toBeVisible();

  const grid = await openDueMenu(page, 'Book the venue');
  const popover = page.locator('.popover');
  await expect(popover.getByText(monthTitle(isoDay(0)))).toBeVisible();
  await expect(grid.locator(`[data-date="${isoDay(0)}"]`)).toHaveAttribute('aria-current', 'date');

  await popover.getByRole('button', { name: 'Next month' }).click();
  await popover.getByRole('button', { name: 'Next month' }).click();
  await expect(popover.getByText(monthTitle(dayInMonth(2, 1)))).toBeVisible();
  await expect(grid, 'the menu stays open').toBeVisible();
  expect(await dueOf(request, user, t.id), 'no date set by navigating').toBeNull();
  await expect(page.getByRole('dialog', { name: 'Task details' }), 'clicks in the menu do not open the task').toHaveCount(0);

  const target = dayInMonth(2, 15);
  await grid.locator(`[data-date="${target}"]`).click();
  await expect(popover).toHaveCount(0);
  await eventually(() => dueOf(request, user, t.id), (d) => d === target, 'due date saved');

  // Reopened: the chosen day is selected and the calendar shows its month.
  const again = await openDueMenu(page, 'Book the venue');
  await expect(again.locator(`[data-date="${target}"]`)).toHaveClass(/is-selected/);
  await expect(again.getByRole('gridcell', { selected: true })).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('.popover')).toHaveCount(0);
  expect(await dueOf(request, user, t.id)).toBe(target);
});

test('a repeating task\'s end date uses the same calendar; days before the due date cannot be picked', async ({ page, context, request }) => {
  const user = await createUser(request, 'Ender Date');
  const due = dayInMonth(1, 10);
  const t = await createTask(request, user, user.wsId, { title: 'Water the garden', dueDate: due });
  await signInContext(context, user);
  await page.goto(tasksUrl(user.wsId, 'all'));
  await taskRow(page, 'Water the garden').click();
  const detail = page.getByRole('dialog', { name: 'Task details' });
  await detail.getByRole('button', { name: 'Does not repeat' }).click();
  await page.getByRole('menuitem', { name: 'Custom…' }).click();
  await page.locator('.popover').getByLabel('Ends').selectOption('until');
  const grid = page.locator('.popover').getByRole('grid', { name: 'End date' });
  await expect(grid).toBeVisible();
  const before = dayInMonth(1, 9);
  await expect(grid.locator(`[data-date="${before}"]`)).toHaveAttribute('aria-disabled', 'true');
  await grid.locator(`[data-date="${before}"]`).click({ force: true }); // aria-disabled: Playwright won't click it otherwise
  await expect(page.locator('.popover').getByRole('button', { name: 'Save' })).toBeDisabled();
  await page.locator('.popover').getByRole('button', { name: 'Next month' }).click();
  const end = dayInMonth(2, 20);
  await grid.locator(`[data-date="${end}"]`).click();
  await expect(grid, 'picking an end date keeps the editor open').toBeVisible();
  await page.locator('.popover').getByRole('button', { name: 'Save' }).click();
  await eventually(
    async () => (await api<{ id: string; recurrence: { until?: string } | null }[]>(request, 'GET', `/workspaces/${user.wsId}/tasks`, user.token)).find((x) => x.id === t.id)?.recurrence?.until,
    (u) => u === end,
    'end date saved',
  );
});

test('keyboard: arrows move the focused day, PageDown changes month, Enter picks', async ({ page, context, request }) => {
  const user = await createUser(request, 'Kay Board');
  const start = dayInMonth(1, 10);
  const t = await createTask(request, user, user.wsId, { title: 'Renew the lease', dueDate: start });
  await signInContext(context, user);
  await page.goto(tasksUrl(user.wsId, 'all'));
  await expect(taskRow(page, 'Renew the lease')).toBeVisible();

  const grid = await openDueMenu(page, 'Renew the lease');
  // The selected day is the grid's tab stop.
  await expect(grid.locator('[tabindex="0"]')).toHaveAttribute('data-date', start);
  await grid.locator(`[data-date="${start}"]`).focus();
  // +1, +7, +7, −7 days = +8; then a month on. Up/Down stay in the grid (not the menu items).
  for (const key of ['ArrowRight', 'ArrowDown', 'ArrowDown', 'ArrowUp', 'PageDown']) await page.keyboard.press(key);
  const target = dayInMonth(2, 18);
  await expect(grid.locator(`[data-date="${target}"]`)).toBeFocused();
  expect(await dueOf(request, user, t.id), 'moving does not pick').toBe(start);
  await page.keyboard.press('Enter');
  await expect(page.locator('.popover')).toHaveCount(0);
  await eventually(() => dueOf(request, user, t.id), (d) => d === target, 'due date saved by keyboard');
});
