// Tags, teams, "assigned by" and server-side saved views (track 1): the tester's four example views,
// quick add with #tag and +team, and the Settings → Teams list.
import { expect, test, type Page } from '@playwright/test';
import { addFilter, api, createTask, createTeam, createUser, eventually, removeFilter, ribbon, signInContext, taskRow, tasksUrl } from './helpers.ts';

/** Desktop: the ribbon's Views group (Save view; Saved views names the current one). */
async function saveView(page: Page, name: string) {
  await ribbon(page).getByRole('button', { name: 'Save view' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expectCurrentView(page, name);
}

const expectCurrentView = (page: Page, name: string) => expect(ribbon(page).getByRole('button', { name: `Saved views: ${name}` })).toBeVisible();

async function openSavedView(page: Page, name: string) {
  await ribbon(page).getByRole('button', { name: /^Saved views/ }).click();
  await page.getByRole('menuitem', { name }).click();
}

const clearFilters = (page: Page) => ribbon(page).getByRole('button', { name: 'Clear filters' }).click();

async function expectRows(page: Page, shown: string[], hidden: string[]) {
  for (const t of shown) await expect(taskRow(page, t)).toBeVisible();
  for (const t of hidden) await expect(taskRow(page, t)).toHaveCount(0);
}

test('the four example views can be built, saved on the server and reopened', async ({ page, context, request }) => {
  const owner = await createUser(request, 'Olive Owner');
  const scott = await createUser(request, 'Scott Elder');
  const ws = await createTeam(request, owner, [{ user: scott, role: 'member' }], 'Church');
  const elders = await api<{ id: string }>(request, 'POST', `/workspaces/${ws}/teams`, owner.token, { name: 'Elders', memberIds: [owner.id, scott.id] });
  const shepherds = await api<{ id: string }>(request, 'POST', `/workspaces/${ws}/teams`, owner.token, { name: 'Shepherds', parentId: elders.id, memberIds: [scott.id] });
  const staff = await api<{ id: string }>(request, 'POST', `/workspaces/${ws}/teams`, owner.token, { name: 'Staff', memberIds: [scott.id] });
  const waiting = await api<{ id: string }>(request, 'POST', `/workspaces/${ws}/tags`, owner.token, { name: 'Waiting' });

  await createTask(request, owner, ws, { title: 'Elders unassigned', teamId: elders.id, tagIds: [waiting.id] });
  await createTask(request, owner, ws, { title: 'Shepherd visit', teamId: shepherds.id, assigneeId: scott.id });
  await createTask(request, owner, ws, { title: 'Scott elders task', teamId: elders.id, assigneeId: scott.id });
  await createTask(request, owner, ws, { title: 'Scott staff task', teamId: staff.id, assigneeId: scott.id });
  await createTask(request, scott, ws, { title: 'Scott self-assigned', assigneeId: scott.id });
  await createTask(request, owner, ws, { title: 'Owner own task', assigneeId: owner.id });
  const done = await createTask(request, owner, ws, { title: 'Elders finished', teamId: elders.id });
  await api(request, 'PATCH', `/tasks/${done.id}`, owner.token, { status: 'done' });

  await signInContext(context, owner);
  await page.goto(tasksUrl(ws, 'all'));
  await expect(taskRow(page, 'Owner own task')).toBeVisible();
  // Rows show the team badge and tag chips.
  await expect(taskRow(page, 'Elders unassigned').locator('.team-badge')).toContainText('Elders');
  await expect(taskRow(page, 'Elders unassigned').locator('.tag-chip')).toHaveText('Waiting');
  await expect(taskRow(page, 'Shepherd visit').locator('.team-badge')).toContainText('Elders › Shepherds');

  // 1. All unfinished Elders tasks: team = Elders (with subteams), status = open.
  await addFilter(page, 'Team', 'Elders');
  await expectRows(page, ['Elders unassigned', 'Shepherd visit', 'Scott elders task'], ['Scott staff task', 'Elders finished', 'Owner own task']);
  await saveView(page, 'Unfinished Elders');
  // Without subteams, the Shepherds task drops out.
  await ribbon(page).getByRole('button', { name: 'Team filter', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Include subteams' }).click();
  await page.keyboard.press('Escape');
  await expectRows(page, ['Scott elders task'], ['Shepherd visit']);
  await removeFilter(page, 'Team');

  // 2. All tasks assigned to Scott across teams.
  await addFilter(page, 'Assignee', 'Scott Elder');
  await expectRows(page, ['Shepherd visit', 'Scott elders task', 'Scott staff task', 'Scott self-assigned'], ['Elders unassigned', 'Owner own task']);
  await saveView(page, 'Scott everywhere');

  // 3. Scott's Elders tasks: team = Elders and assignee = Scott (his Staff task stays out).
  await addFilter(page, 'Team', 'Elders');
  await expectRows(page, ['Shepherd visit', 'Scott elders task'], ['Scott staff task', 'Scott self-assigned']);
  await saveView(page, 'Scott in Elders');
  await clearFilters(page);

  // 4. Tasks I assigned to others: assigned by = me, assignee is not me.
  await addFilter(page, 'Assigned by', 'Me');
  await addFilter(page, 'Assignee', 'Someone else');
  await expectRows(page, ['Shepherd visit', 'Scott elders task', 'Scott staff task'], ['Scott self-assigned', 'Owner own task', 'Elders unassigned']);
  await saveView(page, 'I assigned to others');

  // Saved on the server, personal to the owner.
  const views = await api<{ id: string; name: string; shared: boolean }[]>(request, 'GET', `/workspaces/${ws}/task-views`, owner.token);
  expect(views.map((v) => v.name)).toEqual(['Unfinished Elders', 'Scott everywhere', 'Scott in Elders', 'I assigned to others']);
  expect(await api<unknown[]>(request, 'GET', `/workspaces/${ws}/task-views`, scott.token)).toEqual([]);

  // A saved view reopens from its chip and from its link (what the Tasks panel uses).
  await openSavedView(page, 'Unfinished Elders');
  await expectRows(page, ['Elders unassigned', 'Shepherd visit'], ['Scott staff task']);
  await page.goto(`${tasksUrl(ws, 'all')}?view=${views.find((v) => v.name === 'Scott in Elders')!.id}`);
  await expectCurrentView(page, 'Scott in Elders');
  await expectRows(page, ['Shepherd visit', 'Scott elders task'], ['Scott staff task']);

  // Without the Waiting tag.
  await clearFilters(page);
  await addFilter(page, 'Without tags', 'Waiting');
  await expectRows(page, ['Shepherd visit'], ['Elders unassigned']);
});

test('Tasks ribbon: a tag filter from the ribbon, saved as a view; in-page duplicates are gone on desktop', async ({ page, context, request }) => {
  const user = await createUser(request, 'Rita Ribbon');
  const tag = await api<{ id: string }>(request, 'POST', `/workspaces/${user.wsId}/tags`, user.token, { name: 'Urgent' });
  await createTask(request, user, user.wsId, { title: 'Tagged one', tagIds: [tag.id] });
  await createTask(request, user, user.wsId, { title: 'Plain one' });
  await signInContext(context, user);
  await page.goto(tasksUrl(user.wsId, 'today'));
  const bar = ribbon(page);
  // Grouping is fixed on Today; the filters work there too.
  await expect(bar.getByRole('button', { name: 'Tags filter' })).not.toHaveAttribute('aria-disabled', 'true');
  await expect(bar.getByRole('button', { name: 'Group by' })).toHaveAttribute('aria-disabled', 'true');
  await bar.getByRole('button', { name: 'All Tasks' }).click();
  await expect(page).toHaveURL(/\/tasks\/all$/);
  await expect(bar.getByRole('button', { name: 'All Tasks' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Add filter' })).toHaveCount(0);
  await expect(page.locator('.saved-views, .select-label')).toHaveCount(0);

  await addFilter(page, 'Tags', 'Urgent');
  await expectRows(page, ['Tagged one'], ['Plain one']);
  await expect(bar.getByRole('button', { name: 'Tags filter' })).toHaveClass(/is-active/);
  await expect(bar.getByRole('button', { name: 'Tags filter' }).locator('.rb-count')).toHaveText('1');
  await saveView(page, 'Urgent things');
  await expect(bar.getByRole('button', { name: 'Save view' })).toHaveAttribute('aria-disabled', 'true');
  await eventually(
    () => api<{ name: string }[]>(request, 'GET', `/workspaces/${user.wsId}/task-views`, user.token),
    (vs) => vs.some((v) => v.name === 'Urgent things'),
    'the view is saved on the server',
  );
  await clearFilters(page);
  await expectRows(page, ['Tagged one', 'Plain one'], []);
  await openSavedView(page, 'Urgent things');
  await expectRows(page, ['Tagged one'], ['Plain one']);
});

test('quick add understands #tag and +team; task details show team, tags and assigned by', async ({ page, context, request }) => {
  const owner = await createUser(request, 'Tara Tagger');
  const sam = await createUser(request, 'Sam Helper');
  const ws = await createTeam(request, owner, [{ user: sam, role: 'member' }], 'Tags');
  await api(request, 'POST', `/workspaces/${ws}/teams`, owner.token, { name: 'Staff', memberIds: [sam.id] });
  await signInContext(context, owner);
  await page.goto(tasksUrl(ws, 'all'));
  await expect(page.getByRole('heading', { name: 'All Tasks', level: 1 })).toBeVisible();

  await page.keyboard.press('q');
  await page.getByPlaceholder(/e\.g\./).fill('Call the printer #Waiting +staff @sam');
  await page.getByRole('dialog', { name: 'Quick add task' }).getByRole('button', { name: 'Add task' }).click();
  await eventually(
    () => api<{ title: string; teamId: string | null; tagIds: string[]; assignedBy: string | null }[]>(request, 'GET', `/workspaces/${ws}/tasks`, owner.token),
    (ts) => ts.some((t) => t.title === 'Call the printer' && !!t.teamId && t.tagIds.length === 1 && t.assignedBy === owner.id),
    'quick add created the task with its team, a new Waiting tag and assigned by',
  );
  await taskRow(page, 'Call the printer').locator('.task-title').click();
  const sheet = page.getByRole('dialog', { name: 'Task details' });
  await expect(sheet.locator('.prop', { hasText: 'Team' })).toContainText('Staff');
  await expect(sheet.locator('.prop', { hasText: 'Tags' })).toContainText('Waiting');
  await expect(sheet).toContainText('Assigned by Tara Tagger');

  // Settings → Teams lists the team for everyone; members can't manage it.
  await page.goto(`/w/${ws}/settings?s=teams`);
  await expect(page.getByRole('heading', { name: 'Teams', level: 1 })).toBeVisible();
  await expect(page.locator('.team-row[data-team="Staff"]')).toContainText('1 member');
  await page.goto(`/w/${ws}/settings?s=tags`);
  await expect(page.locator('[data-tag="Waiting"]')).toContainText('1 open task');
});
