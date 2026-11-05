// Priority 4: permissions — viewers can't edit; private notebooks are hidden from other members.
import { expect, test } from '@playwright/test';
import { api, createPage, createTask, createTeam, createUser, openPage, signInContext, taskRow, tasksUrl } from './helpers.ts';

test('a viewer can read but not edit pages or tasks', async ({ page, context, request }) => {
  const owner = await createUser(request, 'Owen Owner');
  const viewer = await createUser(request, 'Vera Viewer');
  const teamId = await createTeam(request, owner, [{ user: viewer, role: 'viewer' }]);
  const { pageId } = await createPage(request, owner, { wsId: teamId, page: 'Read only doc' });
  await createTask(request, owner, teamId, { title: 'Owner task', assigneeId: viewer.id, dueDate: null });
  await signInContext(context, viewer);

  await page.goto(`/w/${teamId}/p/${pageId}`);
  await expect(page.locator('.page-topbar')).toContainText('View only');
  const editor = page.locator('.ProseMirror');
  await expect(editor).toHaveAttribute('contenteditable', 'false');
  await expect(page.locator('.page-title')).toHaveAttribute('readonly', '');

  // No create affordances in the sidebar.
  await expect(page.getByRole('button', { name: 'New notebook', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add task' })).toHaveCount(0);

  // Tasks are visible but their checkboxes are disabled.
  await page.goto(tasksUrl(teamId, 'my'));
  await expect(taskRow(page, 'Owner task').getByRole('checkbox')).toBeDisabled();

  // The server enforces it too.
  await expect(api(request, 'POST', `/workspaces/${teamId}/tasks`, viewer.token, { title: 'nope' })).rejects.toThrow(/403/);
  await expect(api(request, 'PATCH', `/pages/${pageId}`, viewer.token, { title: 'hacked' })).rejects.toThrow(/403/);
});

test('a viewer’s keystrokes never reach the document', async ({ browser, request }) => {
  const owner = await createUser(request, 'Olga Owner');
  const viewer = await createUser(request, 'Vic Viewer');
  const teamId = await createTeam(request, owner, [{ user: viewer, role: 'viewer' }]);
  const { pageId } = await createPage(request, owner, { wsId: teamId });

  const vc = await browser.newContext();
  await signInContext(vc, viewer);
  const v = await vc.newPage();
  await openPage(v, teamId, pageId);
  await v.locator('.ProseMirror').click();
  await v.keyboard.type('viewer was here');

  const oc = await browser.newContext();
  await signInContext(oc, owner);
  const o = await oc.newPage();
  await openPage(o, teamId, pageId);
  await o.locator('.ProseMirror').click();
  await o.keyboard.type('owner text');
  await expect(v.locator('.ProseMirror')).toContainText('owner text');
  await expect(o.locator('.ProseMirror')).not.toContainText('viewer was here');
  await vc.close();
  await oc.close();
});

test('a private notebook is hidden from other members', async ({ browser, request }) => {
  const alice = await createUser(request, 'Alice Private');
  const bob = await createUser(request, 'Bob Outsider');
  const teamId = await createTeam(request, alice, [{ user: bob, role: 'member' }]);
  const priv = await createPage(request, alice, { wsId: teamId, notebook: 'Alice Diary', page: 'Dear diary', visibility: 'private' });
  await createPage(request, alice, { wsId: teamId, notebook: 'Team Wiki', page: 'Welcome' });
  await createTask(request, alice, teamId, { title: 'Private chore', pageId: priv.pageId });

  const ac = await browser.newContext();
  await signInContext(ac, alice);
  const a = await ac.newPage();
  await a.goto(`/w/${teamId}/p/${priv.pageId}`);
  const aSidebar = a.getByRole('navigation', { name: 'Sidebar' });
  await expect(aSidebar.getByText('Alice Diary')).toBeVisible();
  await expect(aSidebar.getByLabel('Private notebook')).toBeVisible();

  const bc = await browser.newContext();
  await signInContext(bc, bob);
  const b = await bc.newPage();
  await b.goto(`/w/${teamId}/tasks/all`);
  const bSidebar = b.getByRole('navigation', { name: 'Sidebar' });
  await expect(bSidebar.getByText('Team Wiki')).toBeVisible();
  await expect(bSidebar.getByText('Alice Diary')).toHaveCount(0);
  await expect(taskRow(b, 'Private chore')).toHaveCount(0);

  // Direct link to the private page doesn't open it.
  await b.goto(`/w/${teamId}/p/${priv.pageId}`);
  await expect(b.locator('.ProseMirror')).toHaveCount(0);
  await expect(b.getByText('Dear diary')).toHaveCount(0);

  // Alice shares it → it appears for Bob live.
  await b.goto(`/w/${teamId}/tasks/all`);
  await expect(bSidebar.getByText('Team Wiki')).toBeVisible();
  const nbRow = a.locator('.sb-row', { hasText: 'Alice Diary' });
  await nbRow.hover();
  await nbRow.getByRole('button', { name: 'Notebook options', exact: true }).click();
  await a.getByRole('menuitem', { name: 'Share with workspace' }).click();
  await expect(bSidebar.getByText('Alice Diary')).toBeVisible();
  await ac.close();
  await bc.close();
});
