// Priority 2 — the core promise: a task written in a note is a real task, in sync with the dashboard both ways.
import { expect, test } from '@playwright/test';
import { addInlineTask, createPage, createUser, eventually, listTasks, openPage, pageUrl, signInContext, taskRef, taskRow, tasksUrl } from './helpers.ts';

test.describe('inline tasks ↔ dashboard', () => {
  test('an inline task shows up in Today and My Tasks, linked to its note', async ({ page, context, request }) => {
    const user = await createUser(request, 'Nora Notes');
    const { pageId } = await createPage(request, user, { page: 'Sprint planning' });
    await signInContext(context, user);

    await openPage(page, user.wsId, pageId);
    await addInlineTask(page, 'Email the venue today');
    // Quick-add tokens typed into an inline task are parsed: "today" becomes the due date.
    const ref = taskRef(page, 'Email the venue');
    await expect(ref).toBeVisible();

    // Server has the task linked to this page (set by the reconcile on save).
    await eventually(
      () => listTasks(request, user),
      (ts) => ts.some((t) => t.title === 'Email the venue' && t.pageId === pageId),
      'task linked to its source page',
    );

    await page.getByRole('link', { name: 'Today' }).click();
    await expect(page).toHaveURL(new RegExp(tasksUrl(user.wsId, 'today')));
    const row = taskRow(page, 'Email the venue');
    await expect(row).toBeVisible();
    await expect(row.getByTitle('Open in note')).toContainText('Sprint planning');

    await page.getByRole('link', { name: 'My Tasks' }).click();
    await expect(taskRow(page, 'Email the venue')).toBeVisible();

    // The source chip goes back to the note.
    await taskRow(page, 'Email the venue').getByTitle('Open in note').click();
    await expect(page).toHaveURL(new RegExp(`${pageUrl(user.wsId, pageId)}\\?task=`));
    await expect(taskRef(page, 'Email the venue')).toBeVisible();
  });

  test('complete on the dashboard → completed in the note, and vice versa', async ({ page, context, request }) => {
    const user = await createUser(request, 'Dana Done');
    const { pageId } = await createPage(request, user);
    await signInContext(context, user);

    await openPage(page, user.wsId, pageId);
    await addInlineTask(page, 'Book flights today');
    await addInlineTask(page, 'Pack bags today');
    await eventually(
      () => listTasks(request, user),
      (ts) => ts.filter((t) => t.pageId === pageId).length === 2,
      'both tasks linked to the page',
    );

    // Dashboard → note
    await page.goto(tasksUrl(user.wsId, 'today'));
    await taskRow(page, 'Book flights').getByRole('checkbox', { name: 'Complete task' }).click();
    await eventually(() => listTasks(request, user), (ts) => ts.find((t) => t.title === 'Book flights')?.status === 'done', 'completed on server');
    await page.goto(pageUrl(user.wsId, pageId));
    await expect(taskRef(page, 'Book flights')).toHaveClass(/is-done/);
    await expect(taskRef(page, 'Pack bags')).not.toHaveClass(/is-done/);

    // Note → dashboard
    await taskRef(page, 'Pack bags').getByRole('checkbox', { name: 'Complete task' }).click();
    await expect(taskRef(page, 'Pack bags')).toHaveClass(/is-done/);
    await page.getByRole('link', { name: 'Completed' }).click();
    await expect(taskRow(page, 'Pack bags')).toBeVisible();
    await expect(taskRow(page, 'Book flights')).toBeVisible();

    // Un-complete from the Completed view → open again in the note.
    await taskRow(page, 'Pack bags').getByRole('checkbox', { name: 'Mark as not done' }).click();
    await page.goto(pageUrl(user.wsId, pageId));
    await expect(taskRef(page, 'Pack bags')).not.toHaveClass(/is-done/);
  });

  test('note and dashboard update live in the same session (no reload)', async ({ context, request }) => {
    const user = await createUser(request, 'Liam Live');
    const { pageId } = await createPage(request, user);
    await signInContext(context, user);
    const note = await context.newPage();
    const dash = await context.newPage();

    await openPage(note, user.wsId, pageId);
    await dash.goto(tasksUrl(user.wsId, 'today'));
    await expect(dash.getByRole('heading', { name: 'Today', level: 1 })).toBeVisible();

    await addInlineTask(note, 'Live task today');
    await expect(taskRow(dash, 'Live task')).toBeVisible();

    await taskRow(dash, 'Live task').getByRole('checkbox', { name: 'Complete task' }).click();
    await expect(taskRef(note, 'Live task')).toHaveClass(/is-done/);
  });

  test('edit the title in the note → dashboard; edit in the dashboard → note', async ({ page, context, request }) => {
    const user = await createUser(request, 'Ella Edit');
    const { pageId } = await createPage(request, user);
    await signInContext(context, user);

    await openPage(page, user.wsId, pageId);
    await addInlineTask(page, 'Draft budget today');
    await eventually(() => listTasks(request, user), (ts) => ts.some((t) => t.title === 'Draft budget'), 'task created');
    const id = (await listTasks(request, user)).find((t) => t.title === 'Draft budget')!.id;

    // In the note: change the title and leave the field to commit.
    const input = page.locator(`.task-ref[data-task-id="${id}"] .task-ref-title`);
    await input.fill('Draft Q4 budget');
    await input.press('Escape');
    await eventually(() => listTasks(request, user), (ts) => ts.some((t) => t.title === 'Draft Q4 budget'), 'title saved from the note');
    await page.goto(tasksUrl(user.wsId, 'today'));
    await expect(taskRow(page, 'Draft Q4 budget')).toBeVisible();

    // In the dashboard: open details, edit the title.
    await taskRow(page, 'Draft Q4 budget').click();
    const detail = page.getByRole('dialog', { name: 'Task details' });
    await detail.locator('#task-title').fill('Final Q4 budget');
    await detail.locator('#task-title').press('Enter');
    await detail.getByRole('button', { name: 'Close (Esc)', exact: true }).click();
    await expect(taskRow(page, 'Final Q4 budget')).toBeVisible();

    await page.goto(pageUrl(user.wsId, pageId));
    await expect(taskRef(page, 'Final Q4 budget')).toBeVisible();
  });

  test('removing a task from the note keeps it as a standalone task', async ({ page, context, request }) => {
    const user = await createUser(request, 'Sam Standalone');
    const { pageId } = await createPage(request, user);
    await signInContext(context, user);

    await openPage(page, user.wsId, pageId);
    await addInlineTask(page, 'Keep me around');
    await eventually(() => listTasks(request, user), (ts) => ts.some((t) => t.title === 'Keep me around' && t.pageId === pageId), 'linked');

    // Select the whole node and delete it from the document.
    await taskRef(page, 'Keep me around').locator('.drag-handle').click();
    await page.keyboard.press('Delete');
    await expect(taskRef(page, 'Keep me around')).toHaveCount(0);
    await eventually(
      () => listTasks(request, user),
      (ts) => ts.some((t) => t.title === 'Keep me around' && t.pageId === null),
      'task detached, not deleted',
    );
  });
});
