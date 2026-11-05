// Access changes take effect live for someone who is already looking at the content.
import { expect, test } from '@playwright/test';
import { api, createPage, createTeam, createUser, focusEnd, openPage, signInContext, taskRow, tasksUrl } from './helpers.ts';

async function demoteWhileOpen(browser: import('@playwright/test').Browser, request: import('@playwright/test').APIRequestContext) {
  const alice = await createUser(request, 'Alice Demoter');
  const bob = await createUser(request, 'Bob Demoted');
  const teamId = await createTeam(request, alice, [{ user: bob, role: 'member' }]);
  const { pageId } = await createPage(request, alice, { wsId: teamId });
  const bc = await browser.newContext();
  await signInContext(bc, bob);
  const b = await bc.newPage();
  const editor = await openPage(b, teamId, pageId);
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await api(request, 'PATCH', `/workspaces/${teamId}/members/${bob.id}`, alice.token, { role: 'viewer' });
  await expect.poll(async () => (await api<{ id: string; role: string }[]>(request, 'GET', '/workspaces', bob.token)).find((w) => w.id === teamId)?.role).toBe('viewer');
  return { alice, teamId, pageId, bc, b, editor };
}

test('edits from a member demoted while the page is open are not saved (BUG-2a, fixed in #12)', async ({ browser, request }) => {
  const { alice, teamId, pageId, bc, b, editor } = await demoteWhileOpen(browser, request);
  await focusEnd(b);
  await b.keyboard.type('edit after demotion');
  const ac = await browser.newContext();
  await signInContext(ac, alice);
  const a = await ac.newPage();
  const aEditor = await openPage(a, teamId, pageId);
  await focusEnd(a);
  await a.keyboard.type('alice still edits');
  await expect(editor).toContainText('alice still edits');
  await expect(aEditor).not.toContainText('edit after demotion');
  await a.reload();
  await expect(a.locator('.ProseMirror')).toContainText('alice still edits');
  await expect(a.locator('.ProseMirror')).not.toContainText('edit after demotion');
  await ac.close();
  await bc.close();
});

test('BUG-2b: a member demoted while the page is open sees it become read-only without a reload', async ({ browser, request }) => {
  test.fixme(true, 'BUG-2b (docs/QA.md): the open page stays editable after demotion until reload (also on #12 and #14)');
  const { bc, b, editor } = await demoteWhileOpen(browser, request);
  await expect(b.locator('.page-topbar')).toContainText('View only', { timeout: 10_000 });
  await expect(editor).toHaveAttribute('contenteditable', 'false');
  await expect(b.getByRole('button', { name: 'Add task' })).toHaveCount(0);
  await bc.close();
});

test('notebook made private while another member has a page open: they lose it live', async ({ browser, request }) => {
  const alice = await createUser(request, 'Alice Hider');
  const bob = await createUser(request, 'Bob Kicked');
  const teamId = await createTeam(request, alice, [{ user: bob, role: 'member' }]);
  const { notebookId, pageId } = await createPage(request, alice, { wsId: teamId, notebook: 'Soon Private', page: 'Going away' });
  await api(request, 'POST', `/workspaces/${teamId}/tasks`, alice.token, { title: 'Hidden soon', pageId, assigneeId: alice.id });

  const bc = await browser.newContext();
  await signInContext(bc, bob);
  const b = await bc.newPage();
  await b.goto(tasksUrl(teamId, 'all'));
  await expect(taskRow(b, 'Hidden soon')).toBeVisible();
  await openPage(b, teamId, pageId);

  await api(request, 'PATCH', `/notebooks/${notebookId}`, alice.token, { visibility: 'private' });
  const bSidebar = b.getByRole('navigation', { name: 'Sidebar' });
  await expect(bSidebar.getByText('Soon Private')).toHaveCount(0, { timeout: 10_000 });
  // The editor is disconnected (or replaced by "not found"); the task disappears from the dashboard.
  await expect(b.locator('.sync-live')).toHaveCount(0, { timeout: 10_000 });
  await b.goto(tasksUrl(teamId, 'all'));
  await expect(taskRow(b, 'Hidden soon')).toHaveCount(0);
  await bc.close();
});

test('member removed while the app is open loses the workspace live', async ({ browser, request }) => {
  const alice = await createUser(request, 'Alice Remover');
  const bob = await createUser(request, 'Bob Gone');
  const teamId = await createTeam(request, alice, [{ user: bob, role: 'member' }], 'Leaving Team');
  const { pageId } = await createPage(request, alice, { wsId: teamId, page: 'Team page' });

  const bc = await browser.newContext();
  await signInContext(bc, bob);
  const b = await bc.newPage();
  await openPage(b, teamId, pageId);
  await api(request, 'DELETE', `/workspaces/${teamId}/members/${bob.id}`, alice.token);
  await expect(b.locator('.sync-live')).toHaveCount(0, { timeout: 10_000 });
  // The workspace disappears from the switcher (re-open it until the list has refreshed; the app may also navigate away).
  await expect(async () => {
    await b.keyboard.press('Escape');
    await b.locator('.ws-switch').click();
    await expect(b.locator('.menu').first()).toBeVisible({ timeout: 1_000 });
    await expect(b.locator('.menu').first()).not.toContainText('Leaving Team', { timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  await bc.close();
});
