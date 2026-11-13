// A user whose only workspace was deleted lands on a page that lets them make a new one (it was a dead end).
import { expect, test } from '@playwright/test';
import { api, createUser, signInContext } from './helpers.ts';

test('after deleting their only workspace, the user can create a new one', async ({ page, context, request }) => {
  const user = await createUser(request, 'Nowhere');
  await signInContext(context, user);
  await api(request, 'DELETE', `/workspaces/${user.wsId}`, user.token);
  await page.goto('/');
  await expect(page.getByText('You don’t belong to any workspace yet.')).toBeVisible();
  await page.getByRole('button', { name: 'Create a workspace' }).click();
  await page.getByRole('dialog').getByRole('textbox').fill('Fresh start');
  await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
  await expect(page).toHaveURL(/\/w\/[^/]+/);
  const list = await api<{ name: string }[]>(request, 'GET', '/workspaces', user.token);
  expect(list.map((w) => w.name)).toContain('Fresh start');
});
