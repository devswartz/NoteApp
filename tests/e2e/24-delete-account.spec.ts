// Settings → Delete account: explains what happens, needs the password, signs out and returns to the login page.
import { expect, test } from '@playwright/test';
import { PASSWORD, api, createTeam, createUser, signInContext } from './helpers.ts';

test('delete account: wrong password is refused, the right one deletes, signs out and ends at login', async ({ page, context, request }) => {
  const admin = await createUser(request, 'Ada Admin');
  const owner = await createUser(request, 'Olga Owner');
  const helper = await createUser(request, 'Hal Helper');
  const handedOver = await createTeam(request, owner, [{ user: admin, role: 'admin' }], 'Handed Over Team');
  const plain = await createTeam(request, owner, [{ user: helper, role: 'member' }], 'Plain Members Team');

  await signInContext(context, owner);
  await page.goto(`/w/${owner.wsId}/settings`);
  const card = page.locator('section.danger-zone', { hasText: 'Delete account' });
  await expect(card.getByRole('heading', { name: 'Delete account' })).toBeVisible();
  // What is deleted, what stays, and which workspaces are affected.
  await expect(card).toContainText('Stays:');
  await expect(card.getByTestId('transfer-ws-list')).toContainText('Handed Over Team');
  await expect(card.getByTestId('transfer-ws-list')).toContainText('Ada Admin');
  await expect(card.getByTestId('delete-ws-list')).toContainText('Plain Members Team');

  await card.getByRole('button', { name: 'Delete account…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete your account?' });
  const confirm = dialog.getByRole('button', { name: 'Delete my account' });
  await expect(confirm).toBeDisabled(); // no password yet

  await dialog.getByLabel('Password').fill('not-the-password');
  await confirm.click();
  await expect(dialog.getByText('Incorrect password')).toBeVisible();
  await expect(dialog).toBeVisible(); // still signed in, nothing deleted
  expect((await request.post('/api/auth/login', { data: { email: owner.email, password: PASSWORD } })).status()).toBe(200);

  await dialog.getByLabel('Password').fill(PASSWORD);
  await confirm.click();
  await expect(page).toHaveURL(/\/login/);

  // Gone for real: can't sign in; the other workspace outlived them; the one with only a plain member did not.
  expect((await request.post('/api/auth/login', { data: { email: owner.email, password: PASSWORD } })).status()).toBe(401);
  const members = await api<{ members: { id: string; role: string }[] }>(request, 'GET', `/workspaces/${handedOver}/members`, admin.token);
  expect(members.members.find((m) => m.id === admin.id)?.role).toBe('owner');
  const helperWorkspaces = await api<{ id: string }[]>(request, 'GET', '/workspaces', helper.token);
  expect(helperWorkspaces.some((w) => w.id === plain)).toBe(false);
});
