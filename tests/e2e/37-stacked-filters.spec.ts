// Filters that stack: several values per filter, "is not", select all / clear, search in long lists,
// and the same filters working in every task view (not just All Tasks).
// Set E2E_SHOTS=<dir> to also save screenshots of the menus.
import { expect, test, type Page } from '@playwright/test';
import { api, createTask, createTeam, createUser, ribbon, signInContext, taskRow, tasksUrl } from './helpers.ts';

const shot = async (page: Page, name: string) => {
  if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/${name}.png` });
};

async function expectRows(page: Page, shown: string[], hidden: string[]) {
  for (const t of shown) await expect(taskRow(page, t)).toBeVisible();
  for (const t of hidden) await expect(taskRow(page, t)).toHaveCount(0);
}

// By the label text: a person's option also carries their avatar's initials in its name.
const option = (page: Page, label: string) =>
  page.getByRole('menuitemcheckbox').filter({ has: page.locator('.menu-label', { hasText: new RegExp(`^${label}$`) }) });

test('pick several people, flip to "is not", select all and clear; a saved view keeps it', async ({ page, context, request }) => {
  const owner = await createUser(request, 'Olive Owner');
  const bob = await createUser(request, 'Bob Baker');
  const alice = await createUser(request, 'Alice Adams');
  const tom = await createUser(request, 'Tom Turner');
  const mike = await createUser(request, 'Mike Miller');
  const ws = await createTeam(
    request,
    owner,
    [bob, alice, tom, mike].map((user) => ({ user, role: 'member' as const })),
    'Crew',
  );
  for (const [u, title] of [[bob, 'Bob task'], [alice, 'Alice task'], [tom, 'Tom task'], [mike, 'Mike task']] as const) await createTask(request, owner, ws, { title, assigneeId: u.id, priority: u === mike ? 1 : 2 });
  await createTask(request, owner, ws, { title: 'Nobody task', assigneeId: null });

  await signInContext(context, owner);
  await page.goto(tasksUrl(ws, 'all'));
  await expectRows(page, ['Bob task', 'Alice task', 'Tom task', 'Mike task', 'Nobody task'], []);
  const bar = ribbon(page);

  // Bob, Alice and Tom: Mike stays out because he isn't ticked.
  await bar.getByRole('button', { name: /^Assignee filter/ }).click();
  await option(page, 'Bob Baker').click();
  await option(page, 'Alice Adams').click();
  await option(page, 'Tom Turner').click();
  await shot(page, 'assignee-is');
  await page.keyboard.press('Escape');
  await expectRows(page, ['Bob task', 'Alice task', 'Tom task'], ['Mike task', 'Nobody task']);
  await expect(page.locator('.filter-summary-part[data-filter="assignee"]')).toContainText('Assignee: Bob Baker, Alice Adams +1');

  // "Is not" Mike: everyone else, and the unassigned task, stay.
  await bar.getByRole('button', { name: /^Assignee filter/ }).click();
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await page.getByRole('button', { name: 'Is not', exact: true }).click();
  await option(page, 'Mike Miller').click();
  await shot(page, 'assignee-is-not');
  await page.keyboard.press('Escape');
  await expectRows(page, ['Bob task', 'Alice task', 'Tom task', 'Nobody task'], ['Mike task']);
  await expect(page.locator('.filter-summary-part[data-filter="assignee"]')).toContainText('Assignee is not Mike Miller');

  // Another filter stacks on top (AND), and the view saves and reopens with both.
  await bar.getByRole('button', { name: /^Priority filter/ }).click();
  await option(page, 'Priority 2').click();
  await page.keyboard.press('Escape');
  await expectRows(page, ['Bob task', 'Alice task', 'Tom task'], ['Mike task', 'Nobody task']);
  await bar.getByRole('button', { name: 'Save view' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('Not Mike, priority 2');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Not Mike, priority 2');
  await bar.getByRole('button', { name: 'Clear filters' }).click();
  await expectRows(page, ['Mike task', 'Nobody task'], []);
  await bar.getByRole('button', { name: /^Saved views/ }).click();
  await page.getByRole('menuitem', { name: 'Not Mike, priority 2' }).click();
  await expectRows(page, ['Bob task', 'Alice task', 'Tom task'], ['Mike task', 'Nobody task']);
  await expect(page.locator('.filter-summary-part[data-filter="assignee"]')).toContainText('Assignee is not Mike Miller');

  // Select all, then clear.
  await bar.getByRole('button', { name: 'Clear filters' }).click();
  await bar.getByRole('button', { name: /^Assignee filter/ }).click();
  await page.getByRole('button', { name: 'Select all' }).click();
  await expect(option(page, 'Mike Miller')).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(option(page, 'Mike Miller')).toHaveAttribute('aria-checked', 'false');
});

test('filters stack in Today and My Tasks too, and long lists can be searched', async ({ page, context, request }) => {
  const user = await createUser(request, 'Rita Ribbon');
  const tags = [];
  for (const name of ['Urgent', 'Waiting', 'Budget', 'Events', 'Finance', 'Facilities', 'Youth', 'Worship', 'Outreach']) {
    tags.push(await api<{ id: string }>(request, 'POST', `/workspaces/${user.wsId}/tags`, user.token, { name }));
  }
  const today = new Date().toISOString().slice(0, 10);
  await createTask(request, user, user.wsId, { title: 'Urgent today', dueDate: today, tagIds: [tags[0].id] });
  await createTask(request, user, user.wsId, { title: 'Waiting today', dueDate: today, tagIds: [tags[1].id] });
  await createTask(request, user, user.wsId, { title: 'Plain today', dueDate: today });
  await signInContext(context, user);
  await page.goto(tasksUrl(user.wsId, 'today'));
  await expectRows(page, ['Urgent today', 'Waiting today', 'Plain today'], []);

  const bar = ribbon(page);
  await bar.getByRole('button', { name: /^Tags filter/ }).click();
  await page.getByRole('searchbox', { name: 'Search options' }).fill('wor');
  await expect(option(page, 'Worship')).toBeVisible();
  await expect(option(page, 'Urgent')).toHaveCount(0);
  await page.getByRole('searchbox', { name: 'Search options' }).fill('');
  await option(page, 'Urgent').click();
  await option(page, 'Waiting').click();
  await shot(page, 'tags-long-list');
  await page.keyboard.press('Escape');
  await expectRows(page, ['Urgent today', 'Waiting today'], ['Plain today']);
  await expect(page.locator('.filter-summary-part[data-filter="tagsAny"]')).toBeVisible();

  // Same filters follow you to My Tasks; the line under the heading says what's on, and clears it.
  await bar.getByRole('button', { name: 'My Tasks' }).click();
  await expectRows(page, ['Urgent today', 'Waiting today'], ['Plain today']);
  await page.getByRole('button', { name: 'Clear filters' }).first().click();
  await expectRows(page, ['Urgent today', 'Waiting today', 'Plain today'], []);
});
