// Invite links (#11) and sharing a private notebook with specific people (#14).
import { expect, test, type Browser } from '@playwright/test';
import { PASSWORD, api, createPage, createTeam, createUser, focusEnd, openPage, signInContext, uniqueEmail, type TestUser } from './helpers.ts';

async function signedIn(browser: Browser, user: TestUser) {
  const context = await browser.newContext();
  await signInContext(context, user);
  return { context, page: await context.newPage() };
}

test.describe('invite links', () => {
  test('owner invites by email → invitee opens the link, creates the account and joins', async ({ browser, request }) => {
    const owner = await createUser(request, 'Ivy Inviter');
    const teamId = await createTeam(request, owner, [], 'Link Team');
    const email = uniqueEmail('linkee');

    const a = await signedIn(browser, owner);
    await a.page.goto(`/w/${teamId}/settings`);
    await a.page.getByPlaceholder('teammate@company.com').fill(email);
    await a.page.getByRole('button', { name: 'Invite', exact: true }).click();
    // Email isn't configured in tests, so the app shows the link to copy.
    const link = a.page.locator('.invite-link code');
    await expect(link).toContainText('/invite/');
    const url = new URL((await link.textContent())!.trim());
    await expect(a.page.locator('.member-row', { hasText: email })).toContainText('Invited');

    const bc = await browser.newContext();
    const b = await bc.newPage();
    await b.goto(url.pathname);
    await expect(b.getByRole('heading', { name: 'Join Link Team' })).toBeVisible();
    await expect(b.locator('.auth-card')).toContainText(email);
    await b.getByRole('button', { name: 'Sign in or create an account' }).click();
    await b.getByRole('button', { name: 'Create an account' }).click();
    await b.getByLabel('Name').fill('Lina Linkee');
    await b.getByLabel('Email').fill(email);
    await b.getByLabel('Password').fill(PASSWORD);
    await b.getByRole('button', { name: 'Create account' }).click();
    await expect(b).toHaveURL(new RegExp(`/w/${teamId}`));
    await expect(b.locator('.ws-switch')).toContainText('Link Team');

    await expect(a.page.locator('.member-row', { hasText: 'Lina Linkee' })).toBeVisible();
    await expect(a.page.locator('.member-row', { hasText: 'Invited' })).toHaveCount(0);
    await a.context.close();
    await bc.close();
  });

  test('an invite link opened while signed in as someone else asks to switch account', async ({ browser, request }) => {
    const owner = await createUser(request, 'Oscar Owner');
    const other = await createUser(request, 'Wrong Person');
    const teamId = await createTeam(request, owner, [], 'Mismatch Team');
    const email = uniqueEmail('rightperson');
    const r = await api<{ inviteUrl?: string }>(request, 'POST', `/workspaces/${teamId}/members`, owner.token, { email, role: 'member' });
    expect(r.inviteUrl).toBeTruthy();

    const o = await signedIn(browser, other);
    await o.page.goto(new URL(r.inviteUrl!).pathname);
    await expect(o.page.locator('.auth-card')).toContainText(`You’re signed in as ${other.email}`);
    await expect(o.page.getByRole('button', { name: 'Switch account' })).toBeVisible();
    await expect(o.page.getByRole('button', { name: /^Join / })).toHaveCount(0);
    await o.context.close();
  });

  test('an unknown invite token shows "Invite unavailable"', async ({ page }) => {
    await page.goto('/invite/not-a-real-token');
    await expect(page.getByRole('heading', { name: 'Invite unavailable' })).toBeVisible();
  });
});

test.describe('sharing a private notebook with people', () => {
  test('shared people see and edit it live; others never do; unsharing removes it live', async ({ browser, request }) => {
    const alice = await createUser(request, 'Alice Sharer');
    const bob = await createUser(request, 'Bob Chosen');
    const carol = await createUser(request, 'Carol Left-out');
    const teamId = await createTeam(request, alice, [
      { user: bob, role: 'member' },
      { user: carol, role: 'member' },
    ]);
    const { notebookId, pageId } = await createPage(request, alice, { wsId: teamId, notebook: 'Board Prep', page: 'Agenda draft', visibility: 'private' });

    const b = await signedIn(browser, bob);
    const c = await signedIn(browser, carol);
    await b.page.goto(`/w/${teamId}/tasks/today`);
    await c.page.goto(`/w/${teamId}/tasks/today`);
    const bSidebar = b.page.getByRole('navigation', { name: 'Sidebar' });
    const cSidebar = c.page.getByRole('navigation', { name: 'Sidebar' });
    await expect(bSidebar.getByText('Notebooks')).toBeVisible();
    await expect(bSidebar.getByText('Board Prep')).toHaveCount(0);

    await api(request, 'PUT', `/notebooks/${notebookId}/shares`, alice.token, { userIds: [bob.id] });
    await expect(bSidebar.getByText('Board Prep')).toBeVisible({ timeout: 10_000 });
    await expect(cSidebar.getByText('Board Prep')).toHaveCount(0);
    expect(JSON.stringify(await api(request, 'GET', `/workspaces/${teamId}/tree`, carol.token))).not.toContain(notebookId);

    // Bob (a member) can edit it.
    const editor = await openPage(b.page, teamId, pageId);
    await focusEnd(b.page);
    await b.page.keyboard.type('Bob was invited in');
    await expect(editor).toContainText('Bob was invited in');

    // Only the creator can change sharing.
    await expect(api(request, 'PUT', `/notebooks/${notebookId}/shares`, bob.token, { userIds: [bob.id, carol.id] })).rejects.toThrow(/403/);

    // Unshare → Bob loses it live (sidebar + editor socket).
    await api(request, 'PUT', `/notebooks/${notebookId}/shares`, alice.token, { userIds: [] });
    await expect(bSidebar.getByText('Board Prep')).toHaveCount(0, { timeout: 10_000 });
    await expect(b.page.locator('.sync-live')).toHaveCount(0, { timeout: 10_000 });
    await b.context.close();
    await c.context.close();
  });

  test('the share dialog is reachable from the notebook menu', async ({ page, context, request }) => {
    const alice = await createUser(request, 'Alice Dialog');
    await createPage(request, alice, { notebook: 'Dialog Notebook', visibility: 'private' });
    await signInContext(context, alice);
    await page.goto(`/w/${alice.wsId}/tasks/today`);
    const nbRow = page.locator('.sb-row', { hasText: 'Dialog Notebook' });
    // Right-click opens the same menu as the hover-revealed ⋯ button, without depending on hover.
    await nbRow.locator('.sb-label').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Share with people…' }).click();
    await expect(page.getByRole('dialog', { name: 'Share Dialog Notebook' })).toBeVisible();
  });
});
