// User templates × privacy: a template that would carry a task not everyone in the workspace can see is saved
// private to its creator (server/templates.ts → createTemplate), and other members never see it.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { api, createPage, createTeam, createUser, eventually, listTasks, openPage, signInContext, type TestUser } from './helpers.ts';

type Tpl = { id: string; name: string; visibility: 'workspace' | 'private'; taskCount: number };

async function addPageTask(page: Page, request: APIRequestContext, user: TestUser, wsId: string, pageId: string, title: string) {
  await page.getByRole('button', { name: 'Add a task to this page' }).click();
  await expect(page.locator('.task-ref-title:focus')).toBeVisible();
  await page.keyboard.type(title);
  await page.keyboard.press('Escape');
  await eventually(() => listTasks(request, user, wsId), (ts) => ts.some((t) => t.title === title && t.pageId === pageId), 'task on the page');
}

async function saveAsTemplate(page: Page, name: string) {
  await page.getByRole('button', { name: 'Page options' }).click();
  await page.getByRole('menuitem', { name: 'Save as template…' }).click();
  const dialog = page.getByRole('dialog');
  const message = (await dialog.textContent()) ?? '';
  await dialog.getByRole('textbox').fill(name);
  await dialog.getByRole('button', { name: 'Save template' }).click();
  await expect(dialog).toHaveCount(0);
  return message;
}

// (Moving a whole page into a shared notebook shares its tasks on purpose; tasks only stay private when they
// leave a private-notebook page on their own, see keepPrivateWhenDetaching in server/tasks.ts.)
test('a page in a private notebook is saved as a private template; other members never see it', async ({ page, context, request }) => {
  const alice = await createUser(request, 'Alice Templater');
  const bob = await createUser(request, 'Bob Bystander');
  const teamId = await createTeam(request, alice, [{ user: bob, role: 'member' }]);
  const { pageId } = await createPage(request, alice, { wsId: teamId, notebook: 'Alice only', page: 'Secret checklist', visibility: 'private' });
  await signInContext(context, alice);
  await openPage(page, teamId, pageId);
  await addPageTask(page, request, alice, teamId, pageId, 'Private step');

  const message = await saveAsTemplate(page, 'My secret kit');
  expect(message).toContain('only you will see the template');
  let saved: Tpl | undefined;
  await eventually(async () => (saved = (await api<Tpl[]>(request, 'GET', `/workspaces/${teamId}/templates`, alice.token)).find((t) => t.name === 'My secret kit')), (t) => !!t, 'template saved');
  expect(saved!.visibility).toBe('private');
  expect(saved!.taskCount).toBe(1);
  expect((await api<Tpl[]>(request, 'GET', `/workspaces/${teamId}/templates`, bob.token)).map((t) => t.name)).not.toContain('My secret kit');
});

test('a page in a shared notebook is saved as a workspace template that other members can use', async ({ page, context, request }) => {
  const alice = await createUser(request, 'Alice Sharer');
  const bob = await createUser(request, 'Bob User');
  const teamId = await createTeam(request, alice, [{ user: bob, role: 'member' }]);
  const { pageId } = await createPage(request, alice, { wsId: teamId, notebook: 'Team space', page: 'Onboarding' });
  await signInContext(context, alice);
  await openPage(page, teamId, pageId);
  await addPageTask(page, request, alice, teamId, pageId, 'Set up laptop');
  const message = await saveAsTemplate(page, 'Onboarding kit');
  expect(message).toContain('Everyone in this workspace will be able to see and use this template');
  await eventually(
    () => api<Tpl[]>(request, 'GET', `/workspaces/${teamId}/templates`, bob.token),
    (ts) => ts.find((t) => t.name === 'Onboarding kit')?.visibility === 'workspace',
    'Bob sees the workspace template',
  );
});
