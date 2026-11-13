// The app's own dialogs replace the browser's confirm()/prompt(): removing a member, deleting a workspace (typing its name).
import { expect, test } from '@playwright/test';
import { api, createTeam, createUser, signInContext } from './helpers.ts';

test('removing a member asks in the app\'s own dialog; cancelling keeps them, confirming removes them', async ({ page, context, request }) => {
  const owner = await createUser(request, 'Olga Owner');
  const member = await createUser(request, 'Mel Member');
  const ws = await createTeam(request, owner, [{ user: member, role: 'member' }], 'Dialog Team');
  await signInContext(context, owner);
  let native = 0;
  page.on('dialog', (d) => {
    native++;
    void d.dismiss();
  });
  await page.goto(`/w/${ws}/settings?scope=workspace`);
  await page.getByRole('button', { name: 'Members', exact: true }).click();
  const remove = page.getByRole('button', { name: 'Remove Mel Member' });
  await remove.click();
  const dialog = page.getByRole('dialog', { name: 'Remove Mel Member?' });
  await expect(dialog).toContainText('open tasks will become unassigned');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(remove).toBeVisible();
  await remove.click();
  await page.getByRole('dialog', { name: 'Remove Mel Member?' }).getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(remove).toHaveCount(0);
  const members = await api<unknown>(request, 'GET', `/workspaces/${ws}/members`, owner.token);
  expect(JSON.stringify(members)).not.toContain(member.id);
  expect(native, 'no browser dialog was used').toBe(0);
});

test('deleting a workspace needs its name typed into the app\'s dialog', async ({ page, context, request }) => {
  const owner = await createUser(request, 'Wes Owner');
  const ws = await createTeam(request, owner, [], 'Doomed Workspace');
  await signInContext(context, owner);
  let native = 0;
  page.on('dialog', (d) => {
    native++;
    void d.dismiss();
  });
  await page.goto(`/w/${ws}/settings?scope=workspace`);
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await page.getByRole('button', { name: 'Delete workspace' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete this workspace?' });
  await dialog.getByLabel('Workspace name').fill('Wrong name');
  await dialog.getByRole('button', { name: 'Delete workspace' }).click();
  expect((await api<{ id: string }[]>(request, 'GET', '/workspaces', owner.token)).some((w) => w.id === ws), 'a wrong name deletes nothing').toBe(true);
  await page.getByRole('button', { name: 'Delete workspace' }).click();
  const again = page.getByRole('dialog', { name: 'Delete this workspace?' });
  await again.getByLabel('Workspace name').fill('Doomed Workspace');
  await again.getByRole('button', { name: 'Delete workspace' }).click();
  await expect.poll(async () => (await api<{ id: string }[]>(request, 'GET', '/workspaces', owner.token)).some((w) => w.id === ws)).toBe(false);
  expect(native).toBe(0);
});
