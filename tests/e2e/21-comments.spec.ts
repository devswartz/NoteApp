// Comment threads on selected text (#28, #55, #62): add, see live as another member, reply, resolve.
import { expect, test } from '@playwright/test';
import { api, createPage, createTeam, createUser, eventually, focusEnd, openPage, signInContext } from './helpers.ts';

test('comment on a selection; another member sees it live, replies; resolve', async ({ browser, request }) => {
  const alice = await createUser(request, 'Alice Commenter');
  const bob = await createUser(request, 'Bob Replier');
  const teamId = await createTeam(request, alice, [{ user: bob, role: 'member' }]);
  const { pageId } = await createPage(request, alice, { wsId: teamId, page: 'Proposal' });

  const ac = await browser.newContext();
  await signInContext(ac, alice);
  const a = await ac.newPage();
  const aEditor = await openPage(a, teamId, pageId);
  await focusEnd(a);
  await a.keyboard.type('The budget is fifty thousand');

  const bc = await browser.newContext();
  await signInContext(bc, bob);
  const b = await bc.newPage();
  const bEditor = await openPage(b, teamId, pageId);
  await expect(bEditor).toContainText('The budget is fifty thousand');

  // Alice selects the text and comments on it from the bubble menu.
  await a.keyboard.press('Shift+Home');
  await a.locator('.bubble-menu').getByRole('button', { name: 'Comment' }).click();
  const box = a.getByRole('textbox', { name: 'New comment' });
  await expect(box).toBeFocused();
  await expect(a.locator('.comment-thread.is-active .comment-quote')).toContainText('The budget is fifty thousand');
  await box.fill('Is this before or after tax?');
  await a.locator('.comment-thread.is-active').getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(a.locator('.comment-body', { hasText: 'Is this before or after tax?' })).toBeVisible();
  await expect(aEditor.locator('.comment-anchor[data-thread-id]', { hasText: 'fifty thousand' })).toBeVisible();

  // Bob sees the thread live in the page panel, selects it and replies.
  const bThread = b.locator('.comment-thread', { has: b.locator('.comment-body', { hasText: 'Is this before or after tax?' }) });
  await expect(bThread).toBeVisible({ timeout: 10_000 });
  await bThread.locator('.comment-quote').click();
  const reply = bThread.getByRole('textbox', { name: 'Reply' });
  await reply.fill('Before tax.');
  await bThread.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(a.locator('.comment-body', { hasText: 'Before tax.' })).toBeVisible({ timeout: 10_000 });

  // Resolve.
  // Resolve: the thread moves under "Show 1 resolved" (for Bob too, live), and can be reopened.
  await a.getByRole('button', { name: 'Resolve thread' }).first().click();
  await expect(a.locator('.comment-body', { hasText: 'Is this before or after tax?' })).toHaveCount(0);
  await expect(b.getByRole('button', { name: 'Show 1 resolved' })).toBeVisible({ timeout: 10_000 });
  await a.getByRole('button', { name: 'Show 1 resolved' }).click();
  await a.getByRole('button', { name: 'Reopen thread' }).click();
  await expect(a.getByRole('button', { name: 'Resolve thread' })).toBeVisible();
  await ac.close();
  await bc.close();
});

test('@mentioning someone in a comment notifies them (inbox API)', async ({ browser, request }) => {
  const alice = await createUser(request, 'Alice Mentioner');
  const bob = await createUser(request, 'Bobbie Mentioned');
  const teamId = await createTeam(request, alice, [{ user: bob, role: 'member' }]);
  const { pageId } = await createPage(request, alice, { wsId: teamId, page: 'Launch plan' });

  const ac = await browser.newContext();
  await signInContext(ac, alice);
  const a = await ac.newPage();
  await openPage(a, teamId, pageId);
  await focusEnd(a);
  await a.keyboard.type('Ship on Monday');
  await a.keyboard.press('Shift+Home');
  await a.locator('.bubble-menu').getByRole('button', { name: 'Comment' }).click();
  const box = a.getByRole('textbox', { name: 'New comment' });
  await box.pressSequentially('Can you confirm @Bobb');
  const pick = a.locator('.mention-item', { hasText: 'Bobbie Mentioned' });
  await expect(pick).toBeVisible();
  await pick.click();
  await expect(box).toHaveValue(/@\[Bobbie Mentioned\]\([0-9a-f-]{36}\)/);
  await a.locator('.comment-thread.is-active').getByRole('button', { name: 'Comment', exact: true }).click();
  // Rendered as a mention, not raw markup.
  await expect(a.locator('.comment-body', { hasText: '@Bobbie Mentioned' })).toBeVisible();

  await eventually(
    () => api<{ items: { title: string; body?: string; readAt: string | null }[]; unread: number }>(request, 'GET', '/notifications', bob.token),
    (r) => r.unread >= 1 && r.items.some((n) => /Alice/.test(n.title + (n.body ?? ''))),
    'Bob has an unread notification from Alice',
  );
  // Alice doesn't notify herself.
  const mine = await api<{ unread: number }>(request, 'GET', '/notifications', alice.token);
  expect(mine.unread).toBe(0);
  await ac.close();
});

test('notification bell in the app header shows unread mentions', async ({ page, context, request }) => {
  const alice = await createUser(request, 'Alice Mentioner');
  const bob = await createUser(request, 'Bob Mentioned');
  const teamId = await createTeam(request, alice, [{ user: bob, role: 'member' }]);
  const { pageId } = await createPage(request, alice, { wsId: teamId, page: 'Launch plan' });
  // Alice @mentions Bob in a comment on the page.
  await api(request, 'POST', `/pages/${pageId}/comments`, alice.token, { body: `@[${bob.name}](${bob.id}) can you check the dates?`, quote: '' });

  await signInContext(context, bob);
  await page.goto(`/w/${teamId}/tasks/today`);
  const bell = page.getByRole('button', { name: 'Notifications, 1 unread' });
  await expect(bell).toBeVisible();
  await bell.click();
  const item = page.locator('.inbox-row', { hasText: 'mentioned you' });
  await expect(item).toContainText('Launch plan');
  await item.click();
  await expect(page).toHaveURL(new RegExp(`/p/${pageId}`));
  await expect(page.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible();

  // Still reachable while the sidebar is hidden.
  await page.keyboard.press('ControlOrMeta+Backslash');
  await expect(page.getByRole('button', { name: 'Show sidebar' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible();
});
