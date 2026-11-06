// #99 regressions beyond 25-page-panel: the toolbar counts stay live while the panel is closed, adding a task
// in the note doesn't pop the panel open, and starting a comment opens the Comments tab.
import { expect, test } from '@playwright/test';
import { api, createPage, createTeam, createUser, focusEnd, listTasks, openPage, signInContext } from './helpers.ts';

test('task and comment counts update live (also from another member) and never open the panel', async ({ browser, request }) => {
  const alice = await createUser(request, 'Alice Counter');
  const bob = await createUser(request, 'Bob Completer');
  const teamId = await createTeam(request, alice, [{ user: bob, role: 'member' }]);
  const { pageId } = await createPage(request, alice, { wsId: teamId, page: 'Counted page' });

  const ac = await browser.newContext();
  await signInContext(ac, alice);
  const a = await ac.newPage();
  await openPage(a, teamId, pageId);
  const panel = a.locator('.page-panel');
  const tasksBtn = a.getByRole('button', { name: /^Tasks on this page/ });
  await expect(tasksBtn).toHaveAccessibleName('Tasks on this page');
  await expect(panel).toHaveCount(0);

  // Adding a task in the note bumps the count; the panel stays closed.
  await a.getByRole('button', { name: 'Add a task to this page' }).click();
  await expect(a.locator('.task-ref-title:focus')).toBeVisible();
  await a.keyboard.type('Count me');
  // Let the create reach the server before leaving the task (see BUG-6 for what a slow create does).
  await expect.poll(async () => (await listTasks(request, alice, teamId)).some((t) => t.pageId === pageId)).toBe(true);
  await a.keyboard.press('Escape');
  await expect(tasksBtn).toHaveAccessibleName('Tasks on this page (1 open)');
  await expect(panel).toHaveCount(0);

  // Bob completes it from his side → Alice's count drops live, still closed.
  await expect.poll(async () => (await listTasks(request, alice, teamId)).find((t) => t.title === 'Count me')?.id).toBeTruthy();
  const id = (await listTasks(request, alice, teamId)).find((t) => t.title === 'Count me')!.id;
  await api(request, 'PATCH', `/tasks/${id}`, bob.token, { status: 'done' });
  await expect(tasksBtn).toHaveAccessibleName('Tasks on this page', { timeout: 10_000 });
  await expect(panel).toHaveCount(0);

  // Bob comments on the page → Alice's Comments count appears live, panel still closed.
  const bc = await browser.newContext();
  await signInContext(bc, bob);
  const b = await bc.newPage();
  await openPage(b, teamId, pageId);
  await focusEnd(b);
  await b.keyboard.type('Comment target');
  await b.keyboard.press('Shift+Home');
  await expect(b.locator('.bubble-menu')).toBeVisible();
  await b.locator('.bubble-menu').getByRole('button', { name: 'Comment' }).click();
  // Starting a comment opens the Comments tab with the composer (Bob's side).
  await expect(b.locator('.page-panel')).toHaveAttribute('aria-label', 'Comments');
  await b.getByRole('textbox', { name: 'New comment' }).fill('Is this right?');
  await b.locator('.comment-thread.is-active').getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(a.getByRole('button', { name: 'Comments (1 open)' })).toBeVisible({ timeout: 10_000 });
  await expect(panel).toHaveCount(0);

  // Alice opens Comments from the badge and sees the thread.
  await a.getByRole('button', { name: 'Comments (1 open)' }).click();
  await expect(panel).toHaveAttribute('aria-label', 'Comments');
  await expect(panel.locator('.comment-body', { hasText: 'Is this right?' })).toBeVisible();
  await ac.close();
  await bc.close();
});
