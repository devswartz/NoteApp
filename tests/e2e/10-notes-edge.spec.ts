// Edge cases around notes: move/delete pages and notebooks (tasks survive), ⌘↵ convert to task,
// live tree updates for another member, and the theme preference.
import { expect, test } from '@playwright/test';
import { api, createPage, createTeam, createUser, eventually, focusEnd, isoDay, listTasks, openNotebookPicker, openPage, railTo, signInContext, taskRow, tasksUrl } from './helpers.ts';

test('⌘/Ctrl+Enter turns the current line into a task', async ({ page, context, request }) => {
  const user = await createUser(request, 'Cora Convert');
  const { pageId } = await createPage(request, user);
  await signInContext(context, user);
  await openPage(page, user.wsId, pageId);
  await focusEnd(page);
  await page.keyboard.type('Order more coffee beans');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.locator('.task-ref .task-ref-title')).toHaveValue('Order more coffee beans');
  await eventually(
    () => listTasks(request, user),
    (ts) => ts.some((t) => t.title === 'Order more coffee beans' && t.pageId === pageId),
    'converted line saved as a task linked to the page',
  );
});

test('move a page to another notebook: breadcrumb updates and its tasks stay linked', async ({ page, context, request }) => {
  const user = await createUser(request, 'Max Mover');
  const from = await createPage(request, user, { notebook: 'Inbox Notebook', page: 'Movable page' });
  const to = await createPage(request, user, { notebook: 'Archive Notebook', page: 'Other page' });
  await api(request, 'POST', `/workspaces/${user.wsId}/tasks`, user.token, { title: 'Travels with page', pageId: from.pageId, assigneeId: user.id });
  await signInContext(context, user);

  await page.goto(`/w/${user.wsId}/p/${from.pageId}`);
  await expect(page.locator('.crumbs')).toContainText('Inbox Notebook');
  await page.getByRole('button', { name: 'Page options', exact: true }).click();
  // The target notebook's "General" section.
  const archiveGroup = page.locator('.menu > div', { has: page.locator('.menu-group-title', { hasText: 'Archive Notebook' }) });
  await archiveGroup.getByRole('menuitem', { name: 'General' }).click();
  await expect(page.locator('.toast')).toContainText('Moved to Archive Notebook');
  await expect(page.locator('.crumbs')).toContainText('Archive Notebook');

  const tree = await api<{ pages: { id: string; sectionId: string }[] }>(request, 'GET', `/workspaces/${user.wsId}/tree`, user.token);
  expect(tree.pages.find((p) => p.id === from.pageId)?.sectionId).toBe(to.sectionId);
  expect((await listTasks(request, user)).find((t) => t.title === 'Travels with page')?.pageId).toBe(from.pageId);
});

test('deleting a page or a notebook keeps its tasks listed (on their page in the Trash); deleting forever makes them standalone tasks', async ({ page, context, request }) => {
  const user = await createUser(request, 'Del Eter');
  const p1 = await createPage(request, user, { notebook: 'Doomed Notebook', page: 'Doomed page' });
  const p2 = await createPage(request, user, { notebook: 'Second Notebook', page: 'Also doomed' });
  await api(request, 'POST', `/workspaces/${user.wsId}/tasks`, user.token, { title: 'Survivor one', pageId: p1.pageId, assigneeId: user.id });
  await api(request, 'POST', `/workspaces/${user.wsId}/tasks`, user.token, { title: 'Survivor two', pageId: p2.pageId, assigneeId: user.id });
  await signInContext(context, user);
  page.on('dialog', (d) => void d.accept());

  await page.goto(`/w/${user.wsId}/p/${p1.pageId}`);
  await page.getByRole('button', { name: 'Page options', exact: true }).click();
  await page.getByRole('menuitem', { name: /Delete/ }).click();
  await expect(page).toHaveURL(/\/notes$/);
  await expect(page.locator('.toast')).toContainText('Moved to Trash.');
  await eventually(() => listTasks(request, user), (ts) => ts.find((t) => t.title === 'Survivor one')?.pageId === p1.pageId, 'task still listed, on its page in the Trash');
  await api(request, 'DELETE', `/trash/page/${p1.pageId}`, user.token);
  await eventually(() => listTasks(request, user), (ts) => ts.find((t) => t.title === 'Survivor one')?.pageId === null, 'task detached when the page is deleted forever');

  // Select the other notebook in the Notes panel's picker, then open its menu.
  await (await openNotebookPicker(page)).getByRole('menuitem', { name: /Second Notebook/ }).click();
  const nbRow = page.locator('.sb-row', { hasText: 'Second Notebook' });
  // Right-click opens the same menu as the hover-revealed ⋯ button, without depending on hover.
  await nbRow.locator('.sb-label').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete notebook' }).click();
  // The sidebar confirms in the app's own dialog (not window.confirm).
  await page.getByRole('dialog', { name: /Delete/ }).getByRole('button', { name: 'Move to Trash' }).click();
  await expect(page.getByRole('navigation', { name: 'Sidebar' }).getByText('Second Notebook')).toHaveCount(0);
  const nbs = await api<{ notebookId: string; kind: string; id: string; name: string }[]>(request, 'GET', `/workspaces/${user.wsId}/trash`, user.token);
  await api(request, 'DELETE', `/trash/notebook/${nbs.find((i) => i.name === 'Second Notebook')!.id}`, user.token);
  await eventually(() => listTasks(request, user), (ts) => ts.find((t) => t.title === 'Survivor two')?.pageId === null, 'task detached when the notebook is deleted forever');

  await page.goto(tasksUrl(user.wsId, 'my'));
  await expect(taskRow(page, 'Survivor one')).toBeVisible();
  await expect(taskRow(page, 'Survivor two')).toBeVisible();
});

test('renaming a page updates another member’s sidebar live', async ({ browser, request }) => {
  const alice = await createUser(request, 'Alice Renamer');
  const bob = await createUser(request, 'Bob Watcher');
  const teamId = await createTeam(request, alice, [{ user: bob, role: 'member' }]);
  const { pageId } = await createPage(request, alice, { wsId: teamId, notebook: 'Shared Notebook', page: 'Old title' });

  const bc = await browser.newContext();
  await signInContext(bc, bob);
  const b = await bc.newPage();
  await b.goto(`/w/${teamId}/notes`);
  await (await openNotebookPicker(b)).getByRole('menuitem', { name: /Shared Notebook/ }).click();
  const bSidebar = b.getByRole('navigation', { name: 'Sidebar' });
  await expect(bSidebar.getByRole('tree', { name: 'Pages' }).getByText('Old title')).toBeVisible();

  const ac = await browser.newContext();
  await signInContext(ac, alice);
  const a = await ac.newPage();
  await openPage(a, teamId, pageId);
  await a.locator('.page-title').fill('Brand new title');
  await expect(bSidebar.getByText('Brand new title')).toBeVisible({ timeout: 10_000 });
  await expect(bSidebar.getByText('Old title')).toHaveCount(0);
  await ac.close();
  await bc.close();
});

test('theme preference: dark mode applies and persists', async ({ page, context, request }) => {
  const user = await createUser(request, 'Theo Theme');
  await signInContext(context, user);
  await page.goto(`/w/${user.wsId}/settings?s=appearance`);
  const theme = page.getByRole('radiogroup', { name: 'Theme' });
  await theme.getByRole('radio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(theme.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');

  // System follows the OS.
  await theme.getByRole('radio', { name: 'System' }).click();
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

// BUG-3 (docs/QA.md), fixed: the debounced title save is flushed when leaving the page.
test('a page title typed just before navigating away is still saved', async ({ page, context, request }) => {
  const user = await createUser(request, 'Quick Renamer');
  const { pageId } = await createPage(request, user, { page: 'Original title' });
  await signInContext(context, user);
  await openPage(page, user.wsId, pageId);
  await page.locator('.page-title').fill('Renamed right before leaving');
  await railTo(page, 'Tasks');
  await expect(page).toHaveURL(/\/tasks\/today$/);
  await eventually(
    () => api<{ page: { title: string } }>(request, 'GET', `/pages/${pageId}`, user.token),
    (r) => r.page.title === 'Renamed right before leaving',
    'rename saved despite navigating away',
  );
  // Back in Notes (the rail reopens the last page), the panel shows the new title.
  await railTo(page, 'Notes');
  await expect(page).toHaveURL(new RegExp(`/p/${pageId}$`));
  await expect(page.getByRole('navigation', { name: 'Sidebar' }).getByText('Renamed right before leaving')).toBeVisible();
});

test('a new task left with Escape gets the same cleaned-up title as with Enter', async ({ page, context, request }) => {
  const user = await createUser(request, 'Esc Tasker');
  const { pageId } = await createPage(request, user);
  await signInContext(context, user);
  await openPage(page, user.wsId, pageId);
  await page.getByRole('button', { name: 'Add a task to this page' }).click();
  await expect(page.locator('.task-ref-title:focus')).toBeVisible();
  await page.keyboard.type('Buy lemons tomorrow p1');
  await page.keyboard.press('Escape');
  await eventually(
    () => listTasks(request, user),
    (ts) => ts.some((t) => t.pageId === pageId && t.title === 'Buy lemons' && t.dueDate === isoDay(1)),
    'title cleaned, date parsed',
  );
  // And it stays that way (no late overwrite with the raw text).
  await expect(page.locator('.task-ref-title')).toHaveValue('Buy lemons');
  await page.waitForTimeout(500);
  expect((await listTasks(request, user)).find((t) => t.pageId === pageId)?.title).toBe('Buy lemons');
});

test('leaving a new task with an arrow key also cleans up the title (BUG-5)', async ({ page, context, request }) => {
  const user = await createUser(request, 'Arrow Tasker');
  const { pageId } = await createPage(request, user);
  await signInContext(context, user);
  await openPage(page, user.wsId, pageId);
  await page.getByRole('button', { name: 'Add a task to this page' }).click();
  await expect(page.locator('.task-ref-title:focus')).toBeVisible();
  await page.keyboard.type('Call the plumber tomorrow');
  await page.keyboard.press('ArrowUp');
  await eventually(
    () => listTasks(request, user),
    (ts) => ts.some((t) => t.pageId === pageId && t.title === 'Call the plumber' && t.dueDate === isoDay(1)),
    'title cleaned, date parsed',
  );
  await page.waitForTimeout(500);
  expect((await listTasks(request, user)).find((t) => t.pageId === pageId)?.title).toBe('Call the plumber');
});

// BUG-6: with a slow create, the title PATCH and the empty task's DELETE used to reach the
// server before the POST (404), losing the title and leaving an untitled task behind.
/** Delays every task-create request so it is still in flight while the user keeps typing. */
async function slowCreates(page: import('@playwright/test').Page, ms = 1500) {
  await page.route(/\/api\/workspaces\/[^/]+\/tasks$/, async (route) => {
    if (route.request().method() === 'POST') await new Promise((r) => setTimeout(r, ms));
    await route.continue();
  });
}

for (const leave of ['Enter', 'Escape'] as const) {
  test(`with a slow create, a typed task keeps its title (left with ${leave}) and no stray task survives (BUG-6)`, async ({ page, context, request }) => {
    const user = await createUser(request, `Slow ${leave}`);
    const { pageId } = await createPage(request, user);
    const before = (await listTasks(request, user)).length;
    await signInContext(context, user);
    await slowCreates(page);
    await openPage(page, user.wsId, pageId);
    await page.getByRole('button', { name: 'Add a task to this page' }).click();
    await expect(page.locator('.task-ref-title:focus')).toBeVisible();
    await page.keyboard.type('Call the plumber');
    await page.keyboard.press('Enter'); // commits the title and opens a new empty task below
    if (leave === 'Enter') {
      await expect(page.locator('.task-ref-title')).toHaveCount(2);
      await page.keyboard.press('Enter'); // Enter on the empty task leaves task mode and deletes it
    } else {
      await expect(page.locator('.task-ref-title')).toHaveCount(2);
      await page.keyboard.press('Escape'); // leaves the empty task (kept, untitled, as before)
    }

    // The server ends up with the titled page task, and nothing untitled except an empty task
    // left with Escape (which is kept on purpose) — never an untitled copy of the typed one.
    await eventually(
      () => listTasks(request, user),
      (ts) => ts.some((t) => t.pageId === pageId && t.title === 'Call the plumber'),
      'title saved on the server',
    );
    await page.waitForTimeout(2_000); // let every queued write land
    const ts = await listTasks(request, user);
    const fresh = ts.length - before;
    expect(ts.filter((t) => t.title === 'Call the plumber')).toHaveLength(1);
    expect(fresh).toBe(leave === 'Enter' ? 1 : 2);
    expect(ts.filter((t) => t.title === '' && t.pageId === null)).toHaveLength(0);

    // The note and the dashboard agree, with no client-only phantom.
    await expect(page.locator('.task-ref-title').first()).toHaveValue('Call the plumber');
    await page.goto(tasksUrl(user.wsId, 'all'));
    await expect(taskRow(page, 'Call the plumber')).toHaveCount(1);
    await expect(page.locator('.task-row')).toHaveCount(fresh + before);
  });
}

test('at full speed, deleting a just-created empty task never leaves a phantom in the client (BUG-6)', async ({ page, context, request }) => {
  const user = await createUser(request, 'Fast Phantom');
  const { pageId } = await createPage(request, user);
  await signInContext(context, user);
  await openPage(page, user.wsId, pageId);
  for (let i = 0; i < 4; i++) {
    await page.getByRole('button', { name: 'Add a task to this page' }).click();
    await expect(page.locator('.task-ref-title:focus')).toBeVisible();
    await page.keyboard.type(`Fast ${i}`);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter'); // delete the new empty task straight away
    await expect(page.locator('.task-ref-title')).toHaveCount(i + 1);
  }
  await page.waitForTimeout(1_000);
  const server = await listTasks(request, user);
  expect(server.filter((t) => t.pageId === pageId).map((t) => t.title).sort()).toEqual(['Fast 0', 'Fast 1', 'Fast 2', 'Fast 3']);
  // Same session, no reload: the dashboard shows exactly the server's open tasks (no "Untitled" phantom).
  await railTo(page, 'Tasks');
  await page.getByRole('navigation', { name: 'Sidebar' }).getByRole('link', { name: /All tasks/ }).click();
  await expect(page.locator('.task-row')).toHaveCount(server.filter((t) => t.status === 'open').length);
  await expect(page.locator('.task-row', { hasText: 'Untitled task' })).toHaveCount(0);
});
