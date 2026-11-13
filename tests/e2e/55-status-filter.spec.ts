// Status filter on the task views (Open by default, Completed, All): All tasks and My Tasks, printing what it shows,
// and the old /tasks/completed link.
import { expect, test, type Page } from '@playwright/test';
import { createTask, createUser, isoDay, setStatus, signInContext, taskRow, tasksUrl } from './helpers.ts';

async function seed(request: Parameters<typeof createUser>[0]) {
  const user = await createUser(request, 'Stella Status');
  await createTask(request, user, user.wsId, { title: 'Unfinished alpha', dueDate: isoDay(1) });
  const done = await createTask(request, user, user.wsId, { title: 'Finished beta', dueDate: isoDay(0) });
  await request.fetch(`/api/tasks/${done.id}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${user.token}`, 'content-type': 'application/json' },
    data: JSON.stringify({ status: 'done' }),
  });
  return user;
}

async function expectShown(page: Page, shown: string[], hidden: string[]) {
  for (const t of shown) await expect(taskRow(page, t)).toBeVisible();
  for (const t of hidden) await expect(taskRow(page, t)).toHaveCount(0);
}

for (const [view, path] of [['All tasks', 'all'], ['My Tasks', 'my']] as const) {
  test(`${view}: Status switches between Open, Completed and All`, async ({ page, context, request }) => {
    const user = await seed(request);
    await signInContext(context, user);
    await page.goto(tasksUrl(user.wsId, path));
    // Open is the default and says nothing in the summary.
    await expectShown(page, ['Unfinished alpha'], ['Finished beta']);
    await expect(page.locator('.filter-summary-part[data-filter="status"]')).toHaveCount(0);

    await setStatus(page, 'Completed');
    await expectShown(page, ['Finished beta'], ['Unfinished alpha']);
    await expect(page.locator('.filter-summary-part[data-filter="status"]')).toContainText('Status: Completed');

    await setStatus(page, 'All');
    await expectShown(page, ['Unfinished alpha', 'Finished beta'], []);
    await expect(page.locator('.filter-summary-part[data-filter="status"]')).toContainText('Status: All');
    // Open tasks first, then the finished ones.
    const open = await taskRow(page, 'Unfinished alpha').boundingBox();
    const fin = await taskRow(page, 'Finished beta').boundingBox();
    expect(open!.y).toBeLessThan(fin!.y);

    await setStatus(page, 'Open');
    await expectShown(page, ['Unfinished alpha'], ['Finished beta']);
  });
}

test('the summary line clears Status back to Open', async ({ page, context, request }) => {
  const user = await seed(request);
  await signInContext(context, user);
  await page.goto(tasksUrl(user.wsId, 'my'));
  await setStatus(page, 'Completed');
  await expect(page.locator('.view-filter-line')).toContainText('Status: Completed');
  await page.locator('.view-filter-line').getByRole('button', { name: 'Clear filters' }).click();
  await expectShown(page, ['Unfinished alpha'], ['Finished beta']);
});

test('printing with Status Completed prints only the finished tasks', async ({ page, context, request }) => {
  const user = await seed(request);
  await signInContext(context, user);
  await page.goto(tasksUrl(user.wsId, 'all'));
  await expectShown(page, ['Unfinished alpha'], ['Finished beta']);
  await setStatus(page, 'Completed');
  await expectShown(page, ['Finished beta'], ['Unfinished alpha']);
  // The view is printed as it is on screen: record what is there when the print dialog would open.
  await page.evaluate(() => {
    const w = window as unknown as { __printed: string[] };
    w.__printed = [];
    window.print = () => {
      w.__printed = [...document.querySelectorAll('.task-row .task-title')].map((e) => e.textContent ?? '');
    };
  });
  await page.keyboard.press('Control+p');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __printed: string[] }).__printed.join('|'))).toContain('Finished beta');
  const printed = await page.evaluate(() => (window as unknown as { __printed: string[] }).__printed);
  expect(printed.join('|')).not.toContain('Unfinished alpha');
});

test('/tasks/completed opens All tasks with Status Completed', async ({ page, context, request }) => {
  const user = await seed(request);
  await signInContext(context, user);
  await page.goto(tasksUrl(user.wsId, 'completed'));
  await expect(page).toHaveURL(/\/tasks\/all/);
  await expect(page.getByRole('heading', { name: 'All tasks', level: 1 })).toBeVisible();
  await expectShown(page, ['Finished beta'], ['Unfinished alpha']);
  await expect(page.locator('.filter-summary-part[data-filter="status"]')).toContainText('Status: Completed');
});
