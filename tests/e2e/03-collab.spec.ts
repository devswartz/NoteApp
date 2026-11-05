// Priority 3: two users in two browser contexts — invite, accept, co-edit, live task assignment.
import { expect, test, type Browser } from '@playwright/test';
import { PASSWORD, addInlineTask, api, createPage, createTeam, createUser, focusEnd, openPage, signInContext, taskRow, tasksUrl, uniqueEmail, type TestUser } from './helpers.ts';

async function userPage(browser: Browser, user: TestUser) {
  const context = await browser.newContext();
  await signInContext(context, user);
  return { context, page: await context.newPage() };
}

test('invite by email → invitee signs up and lands in the team workspace', async ({ browser, request }) => {
  const owner = await createUser(request, 'Olivia Owner');
  const teamId = await createTeam(request, owner, [], 'Invite Team');
  const inviteeEmail = uniqueEmail('invitee');

  const a = await userPage(browser, owner);
  await a.page.goto(`/w/${teamId}/settings`);
  await a.page.getByPlaceholder('teammate@company.com').fill(inviteeEmail);
  await a.page.getByRole('button', { name: 'Invite', exact: true }).click();
  await expect(a.page.locator('.toast')).toContainText('Invitation saved');
  const pending = a.page.locator('.member-row', { hasText: inviteeEmail });
  await expect(pending).toContainText('Invited');

  // The invitee signs up with that email in a separate browser.
  const bContext = await browser.newContext();
  const b = await bContext.newPage();
  await b.goto('/login');
  await b.getByRole('button', { name: 'Create an account' }).click();
  await b.getByLabel('Name').fill('Ivan Invitee');
  await b.getByLabel('Email').fill(inviteeEmail);
  await b.getByLabel('Password').fill(PASSWORD);
  await b.getByRole('button', { name: 'Create account' }).click();
  await b.locator('.ws-switch').click();
  await b.locator('.menu').getByRole('button', { name: /Invite Team/ }).click();
  await expect(b.locator('.ws-switch')).toContainText('Invite Team');

  // The owner's member list turns the invite into a member, live.
  await expect(a.page.locator('.member-row', { hasText: 'Ivan Invitee' }).locator('select')).toHaveValue('member');
  await expect(a.page.locator('.member-row', { hasText: 'Invited' })).toHaveCount(0);

  await a.context.close();
  await bContext.close();
});

test('two users co-edit the same page and see each other’s text, cursor and presence', async ({ browser, request }) => {
  const alice = await createUser(request, 'Alice Able');
  const bob = await createUser(request, 'Bob Baker');
  const teamId = await createTeam(request, alice, [{ user: bob, role: 'member' }]);
  const { pageId } = await createPage(request, alice, { wsId: teamId, page: 'Shared doc' });

  const a = await userPage(browser, alice);
  const b = await userPage(browser, bob);
  await openPage(a.page, teamId, pageId);
  await openPage(b.page, teamId, pageId);

  // Presence: each sees the other's avatar in the page header.
  await expect(a.page.locator('.presence [title="Bob Baker is here"]')).toBeVisible();
  await expect(b.page.locator('.presence [title="Alice Able is here"]')).toBeVisible();

  await focusEnd(a.page);
  await a.page.keyboard.type('Hello from Alice');
  await expect(b.page.locator('.ProseMirror')).toContainText('Hello from Alice');

  // Alice's caret, labelled with her name, is shown in Bob's editor.
  await expect(b.page.locator('.collaboration-carets__label', { hasText: 'Alice' })).toBeVisible();

  await focusEnd(b.page);
  await b.page.keyboard.press('Enter');
  await b.page.keyboard.type('And hi from Bob');
  await expect(a.page.locator('.ProseMirror')).toContainText('And hi from Bob');
  await expect(a.page.locator('.collaboration-carets__label', { hasText: 'Bob' })).toBeVisible();

  // Both edits persist on the server.
  await b.context.close();
  await a.page.reload();
  await expect(a.page.locator('.ProseMirror')).toContainText('Hello from Alice');
  await expect(a.page.locator('.ProseMirror')).toContainText('And hi from Bob');
  await a.context.close();
});

test('a task assigned by A appears for B live, without a reload', async ({ browser, request }) => {
  const alice = await createUser(request, 'Alice Assigner');
  const bob = await createUser(request, 'Bobby Receiver');
  const teamId = await createTeam(request, alice, [{ user: bob, role: 'member' }]);
  const { pageId } = await createPage(request, alice, { wsId: teamId, page: 'Handoffs' });

  const a = await userPage(browser, alice);
  const b = await userPage(browser, bob);
  await b.page.goto(tasksUrl(teamId, 'my'));
  await expect(b.page.getByRole('heading', { name: 'My Tasks', level: 1 })).toBeVisible();

  // Inline task in a note with an @mention assigns it to Bob.
  await openPage(a.page, teamId, pageId);
  await addInlineTask(a.page, 'Review the deck @bobby');
  await expect(taskRow(b.page, 'Review the deck')).toBeVisible();

  // Quick add from the dashboard, assigned to Bob.
  await a.page.goto(tasksUrl(teamId, 'today'));
  await expect(a.page.getByRole('heading', { name: 'Today', level: 1 })).toBeVisible();
  await a.page.keyboard.press('q');
  const qa = a.page.getByRole('dialog', { name: 'Quick add task' });
  await qa.locator('.qa-input').fill('Sign the contract today @bobby');
  await qa.getByRole('button', { name: 'Add task' }).click();
  await expect(taskRow(b.page, 'Sign the contract')).toBeVisible();

  // Bob completes it; Alice's Team view updates live.
  await a.page.getByRole('link', { name: 'Team' }).click();
  await expect(taskRow(a.page, 'Sign the contract')).toBeVisible();
  await taskRow(b.page, 'Sign the contract').getByRole('checkbox', { name: 'Complete task' }).click();
  await expect(taskRow(a.page, 'Sign the contract')).toHaveCount(0, { timeout: 10_000 });

  await a.context.close();
  await b.context.close();
});

test('member removed from the workspace loses access', async ({ browser, request }) => {
  const alice = await createUser(request, 'Alice Admin');
  const bob = await createUser(request, 'Bob Removed');
  const teamId = await createTeam(request, alice, [{ user: bob, role: 'member' }]);
  const { pageId } = await createPage(request, alice, { wsId: teamId, page: 'Secret plans' });
  await api(request, 'DELETE', `/workspaces/${teamId}/members/${bob.id}`, alice.token);

  const b = await userPage(browser, bob);
  await b.page.goto(`/w/${teamId}/p/${pageId}`);
  await expect(b.page.locator('.ProseMirror')).toHaveCount(0);
  await expect(b.page.getByText('Secret plans')).toHaveCount(0);
  await b.context.close();
});
