// The Assignee filter and the assignee picker group people by team: subteams nested, people in two teams under both,
// people in no team last. In the filter a team heading ticks all its people (partial tick when some are ticked); search flattens
// the list and names each person's teams. In the single-assignee picker the headings are labels only.
import { expect, test, type Page } from '@playwright/test';
import { api, createUser, createTeam, ribbon, signInContext, taskRow, tasksUrl, type TestUser } from './helpers.ts';

const row = (page: Page, label: string) => page.locator('.fp-opt').filter({ has: page.locator('.menu-label', { hasText: new RegExp(`^${label}`) }) });

async function setup(request: Parameters<typeof createUser>[0]) {
  const owner = await createUser(request, 'Olive Owner');
  const people: TestUser[] = [];
  for (const name of ['Ann Eng', 'Bob Both', 'Cy Design', 'Dee Loose', 'Eli Loose', 'Fay Loose']) people.push(await createUser(request, name));
  const ws = await createTeam(request, owner, people.map((user) => ({ user, role: 'member' as const })), 'Big Workspace');
  const [ann, bob, cy] = people as [TestUser, TestUser, TestUser];
  const post = <T>(path: string, body: unknown) => api<T>(request, 'POST', path, owner.token, body);
  const team = async (name: string, ids: string[], parentId?: string) => {
    const { id } = await post<{ id: string }>(`/workspaces/${ws}/teams`, { name, parentId: parentId ?? null });
    await api(request, 'PUT', `/teams/${id}/members`, owner.token, { userIds: ids });
    return id;
  };
  const eng = await team('Eng', [ann.id]);
  await team('Platform', [bob.id], eng);
  await team('Design', [bob.id, cy.id]);
  for (const u of [ann, bob, cy]) await api(request, 'POST', `/workspaces/${ws}/tasks`, owner.token, { title: `Task for ${u.name}`, assigneeId: u.id });
  return { owner, ws, ann, bob, cy };
}

test('the Assignee filter lists people under their teams; ticking a team heading ticks everyone under it, with partial ticks and people in two teams in sync', async ({ page, context, request }) => {
  const { owner, ws } = await setup(request);
  await signInContext(context, owner);
  await page.goto(tasksUrl(ws, 'all'));
  await expect(taskRow(page, 'Task for Ann Eng')).toBeVisible();
  const bar = ribbon(page);
  await bar.getByRole('button', { name: /^Assignee filter/ }).click();

  // Pinned entries, then the teams (Platform nested under Eng), then people in no team.
  await expect(row(page, 'Me')).toBeVisible();
  await expect(row(page, 'Unassigned')).toBeVisible();
  await expect(row(page, 'Eng')).not.toHaveClass(/fp-nested/);
  await expect(row(page, 'Platform')).toHaveClass(/fp-nested/);
  await expect(row(page, 'No team')).toBeVisible();
  // Bob is in Platform and Design: listed under both.
  await expect(row(page, 'Bob Both')).toHaveCount(2);
  const heads = await page.locator('.fp-team .menu-label').allInnerTexts();
  expect(heads.map((h) => h.trim())).toEqual(['Eng', 'Platform', 'Design', 'No team']);

  // Ticking Eng ticks Ann and (through Platform) Bob, in both of his places; Design is partly ticked (Bob, not Cy).
  await row(page, 'Eng').click();
  await expect(row(page, 'Eng').locator('.fp-box')).toHaveClass(/is-on/);
  await expect(row(page, 'Platform').locator('.fp-box')).toHaveClass(/is-on/);
  await expect(row(page, 'Ann Eng')).toHaveAttribute('aria-checked', 'true');
  for (const i of [0, 1]) await expect(row(page, 'Bob Both').nth(i)).toHaveAttribute('aria-checked', 'true');
  await expect(row(page, 'Cy Design')).toHaveAttribute('aria-checked', 'false');
  await expect(row(page, 'Design').locator('.fp-box')).toHaveClass(/is-covered/); // the partial tick
  await expect(row(page, 'Design')).toHaveAttribute('aria-checked', 'false');
  // The filter holds people, not teams.
  await page.keyboard.press('Escape');
  await expect(taskRow(page, 'Task for Ann Eng')).toBeVisible();
  await expect(taskRow(page, 'Task for Bob Both')).toBeVisible();
  await expect(taskRow(page, 'Task for Cy Design')).toHaveCount(0);

  // Ticking the partly ticked Design completes it (Cy joins); ticking it again clears all of Design, including Bob.
  await bar.getByRole('button', { name: /^Assignee filter/ }).click();
  await row(page, 'Design').click();
  await expect(row(page, 'Design')).toHaveAttribute('aria-checked', 'true');
  await expect(row(page, 'Cy Design')).toHaveAttribute('aria-checked', 'true');
  await row(page, 'Design').click();
  await expect(row(page, 'Cy Design')).toHaveAttribute('aria-checked', 'false');
  await expect(row(page, 'Ann Eng')).toHaveAttribute('aria-checked', 'true');
  await expect(row(page, 'Bob Both').first()).toHaveAttribute('aria-checked', 'false');

  // Is not: the same ticks leave those people out.
  await page.getByRole('button', { name: 'Is not', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(taskRow(page, 'Task for Ann Eng')).toHaveCount(0);
  await expect(taskRow(page, 'Task for Cy Design')).toBeVisible();
});

test('searching the Assignee filter flattens the list and shows each person\'s teams in muted text', async ({ page, context, request }) => {
  const { owner, ws } = await setup(request);
  await signInContext(context, owner);
  await page.goto(tasksUrl(ws, 'all'));
  await ribbon(page).getByRole('button', { name: /^Assignee filter/ }).click();
  await page.getByRole('searchbox', { name: 'Search options' }).fill('bob');
  const rows = page.locator('.fp-opt');
  await expect(rows).toHaveCount(1); // listed once, not once per team
  await expect(rows.first()).toContainText('Bob Both');
  await expect(rows.first().locator('.muted')).toContainText('Eng › Platform, Design');
  await expect(page.locator('.fp-team')).toHaveCount(0);
  // Searching by team name finds its people.
  await page.getByRole('searchbox', { name: 'Search options' }).fill('design');
  await expect(rows).toHaveCount(2); // Bob and Cy
  await rows.filter({ hasText: 'Cy Design' }).click();
  await page.keyboard.press('Escape');
  await expect(taskRow(page, 'Task for Cy Design')).toBeVisible();
  await expect(taskRow(page, 'Task for Ann Eng')).toHaveCount(0);
});

test('the assignee picker groups people by team; the headings are labels only', async ({ page, context, request }) => {
  const { owner, ws, bob } = await setup(request);
  await signInContext(context, owner);
  await page.goto(tasksUrl(ws, 'all'));
  await taskRow(page, 'Task for Ann Eng').click();
  await page.locator('.prop', { hasText: 'Assignee' }).getByRole('button').first().click();
  const menu = page.locator('.menu').last();
  await expect(menu.locator('.menu-label-row')).toContainText(['Eng', 'Platform', 'Design', 'No team']);
  // A heading is not an item: only people (and Unassigned) can be chosen.
  await expect(menu.getByRole('menuitem', { name: 'Platform' })).toHaveCount(0);
  await expect(menu.getByRole('menuitem', { name: /Bob Both/ })).toHaveCount(2);
  await menu.getByRole('menuitem', { name: /Bob Both/ }).last().click();
  await expect.poll(async () => (await api<{ title: string; assigneeId: string }[]>(request, 'GET', `/workspaces/${ws}/tasks`, owner.token)).find((t) => t.title === 'Task for Ann Eng')?.assigneeId).toBe(bob.id);
});
