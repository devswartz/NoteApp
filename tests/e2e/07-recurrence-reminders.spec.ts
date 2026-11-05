// Priority 7: recurring task completion creates the next occurrence; reminder settings UI.
import { expect, test } from '@playwright/test';
import { api, createTask, createUser, eventually, isoDay, listTasks, signInContext, taskRow, tasksUrl } from './helpers.ts';

type FullTask = Awaited<ReturnType<typeof listTasks>>[number] & { recurrence: unknown; completedAt: string | null };

test('completing a daily task rolls it to tomorrow and keeps a completed copy', async ({ page, context, request }) => {
  const user = await createUser(request, 'Rita Recurring');
  await signInContext(context, user);
  await page.goto(tasksUrl(user.wsId, 'today'));
  await expect(page.getByRole('heading', { name: 'Today', level: 1 })).toBeVisible();

  await page.keyboard.press('q');
  const qa = page.getByRole('dialog', { name: 'Quick add task' });
  await qa.locator('.qa-input').fill('Water the plants today every day');
  await expect(qa.locator('.qa-chips')).toContainText(/day/i);
  await qa.locator('.qa-input').press('Enter');

  const row = taskRow(page, 'Water the plants');
  await expect(row).toBeVisible();
  await row.getByRole('checkbox', { name: 'Complete task' }).click();

  // Server: the series moved to tomorrow, and a done copy exists for history.
  await eventually(
    () => api<FullTask[]>(request, 'GET', `/workspaces/${user.wsId}/tasks`, user.token),
    (ts) => {
      const mine = ts.filter((t) => t.title === 'Water the plants');
      return mine.some((t) => t.status === 'open' && t.dueDate === isoDay(1) && !!t.recurrence) && mine.some((t) => t.status === 'done');
    },
    'next occurrence + completed copy',
  );

  // UI: gone from Today (after the completion animation), on Upcoming for tomorrow, and listed in Completed.
  await expect(taskRow(page, 'Water the plants')).toHaveCount(0, { timeout: 10_000 });
  await page.getByRole('link', { name: 'Upcoming' }).click();
  await expect(taskRow(page, 'Water the plants')).toBeVisible();
  await expect(taskRow(page, 'Water the plants')).toContainText('Tomorrow');
  await page.getByRole('link', { name: 'Completed' }).click();
  await expect(taskRow(page, 'Water the plants')).toHaveCount(1);
});

test('set "Repeat" from task details; weekly task moves a week ahead on completion', async ({ page, context, request }) => {
  const user = await createUser(request, 'Wes Weekly');
  const t = await createTask(request, user, user.wsId, { title: 'Weekly review', dueDate: isoDay(0) });
  await signInContext(context, user);
  await page.goto(tasksUrl(user.wsId, 'today'));
  await taskRow(page, 'Weekly review').click();
  const detail = page.getByRole('dialog', { name: 'Task details' });
  await detail.getByRole('button', { name: 'Does not repeat' }).click();
  await page.getByRole('button', { name: 'Every week', exact: true }).click();
  await expect(detail.getByRole('button', { name: /week/i }).first()).toBeVisible();
  await eventually(() => api<FullTask[]>(request, 'GET', `/workspaces/${user.wsId}/tasks`, user.token), (ts) => !!ts.find((x) => x.id === t.id)?.recurrence, 'recurrence saved');

  await detail.getByRole('checkbox', { name: 'Complete task' }).click();
  await eventually(
    () => api<FullTask[]>(request, 'GET', `/workspaces/${user.wsId}/tasks`, user.token),
    (ts) => ts.find((x) => x.id === t.id)?.dueDate === isoDay(7),
    'rolled forward one week',
  );
});

test('reminder can be set in task details and shows the bell on the row', async ({ page, context, request }) => {
  const user = await createUser(request, 'Remy Reminder');
  await createTask(request, user, user.wsId, { title: 'Call the dentist', dueDate: isoDay(0) });
  await signInContext(context, user);
  await page.goto(tasksUrl(user.wsId, 'today'));
  await taskRow(page, 'Call the dentist').click();
  const detail = page.getByRole('dialog', { name: 'Task details' });
  await detail.locator('input[type="datetime-local"]').fill(`${isoDay(1)}T09:30`);
  await detail.getByTitle('Close (Esc)').click();
  await expect(taskRow(page, 'Call the dentist').getByLabel('Has reminder')).toBeVisible();
  await eventually(
    () => api<(FullTask & { reminderAt: string | null })[]>(request, 'GET', `/workspaces/${user.wsId}/tasks`, user.token),
    (ts) => ts.find((x) => x.title === 'Call the dentist')?.reminderAt === `${isoDay(1)}T09:30:00.000Z`,
    'reminder saved',
  );
});

test('reminder settings: enabling notifications in Settings', async ({ page, context, request }) => {
  const user = await createUser(request, 'Nina Notify');
  await signInContext(context, user);
  // Headless Chromium always reports "denied", so stand in a Notification API that starts at "default".
  await context.addInitScript(() => {
    let perm: NotificationPermission = 'default';
    class FakeNotification {
      static get permission() {
        return perm;
      }
      static requestPermission() {
        perm = 'granted';
        return Promise.resolve(perm);
      }
      close() {}
    }
    Object.defineProperty(window, 'Notification', { value: FakeNotification, configurable: true });
  });
  await page.goto(`/w/${user.wsId}/settings`);
  await expect(page.getByText('Task reminders')).toBeVisible();
  await page.getByRole('button', { name: 'Enable notifications' }).click();
  await expect(page.getByText('Enabled on this device')).toBeVisible();
});

test('a due reminder shows an in-app toast while the app is open', async ({ page, context, request }) => {
  const user = await createUser(request, 'Toby Toast');
  await createTask(request, user, user.wsId, { title: 'Stretch break', reminderAt: new Date(Date.now() + 5_000).toISOString() });
  await signInContext(context, user);
  await page.clock.install();
  await page.goto(tasksUrl(user.wsId, 'my'));
  await expect(taskRow(page, 'Stretch break')).toBeVisible();
  await page.clock.fastForward(35_000); // past the reminder time and the 30 s check interval
  await expect(page.locator('.toast', { hasText: 'Stretch break' })).toBeVisible();
});

test('reminder delivery settings (web push / email) in Settings', async () => {
  test.fixme(true, 'waiting for feature: Reminders agent — server reminder worker, web push + email, notification settings');
});
