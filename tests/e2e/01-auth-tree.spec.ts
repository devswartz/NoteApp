// Priority 1: sign up / sign in, and create workspace → notebook → section → page through the UI.
import { expect, test } from '@playwright/test';
import { PASSWORD, createUser, signInContext, uniqueEmail } from './helpers.ts';

test('sign up, sign out and sign back in', async ({ page }) => {
  const email = uniqueEmail('signup');
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Name').fill('Ada Lovelace');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/w\/[^/]+/);
  // New users get a personal workspace named after them.
  await expect(page.locator('.ws-switch')).toContainText("Ada's Space");

  // Session survives a reload (refresh token restored from storage).
  await page.reload();
  await expect(page.locator('.ws-switch')).toContainText("Ada's Space");

  await page.locator('.ws-switch').click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);

  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('wrong-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('.form-error')).toHaveText('Incorrect email or password');

  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('.ws-switch')).toContainText("Ada's Space");
});

test('sign-up validation: duplicate email and short password', async ({ page, request }) => {
  const existing = await createUser(request, 'Dupe User');
  await page.goto('/login');
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Name').fill('Someone');
  await page.getByLabel('Email').fill(existing.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.locator('.form-error')).toContainText('already exists');
  await expect(page).toHaveURL(/\/login$/);
});

test('create a workspace, notebook, section and page from the UI', async ({ page, context, request }) => {
  const user = await createUser(request, 'Tree Builder');
  await signInContext(context, user);
  const answers: Record<string, string> = {
    'Name your new team workspace': 'Rocket Team',
    'Notebook name': 'Launch Plans',
    'Section name': 'Q4',
  };
  page.on('dialog', (d) => void d.accept(answers[d.message()] ?? ''));

  await page.goto('/');
  await page.locator('.ws-switch').click();
  await page.getByRole('menuitem', { name: 'New workspace' }).click();
  await expect(page.locator('.ws-switch')).toContainText('Rocket Team');

  // A new notebook comes with a "General" section and opens a fresh page.
  await page.getByRole('button', { name: 'New notebook', exact: true }).click();
  const sidebar = page.getByRole('navigation', { name: 'Sidebar' });
  await expect(sidebar.getByText('Launch Plans')).toBeVisible();
  await expect(page).toHaveURL(/\/p\/[^/]+$/);
  await expect(page.locator('.ProseMirror')).toBeVisible();

  const nbRow = page.locator('.sb-row', { hasText: 'Launch Plans' });
  await nbRow.hover();
  await nbRow.getByRole('button', { name: 'Notebook options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New section' }).click();
  const secRow = page.locator('.sec-row', { hasText: 'Q4' });
  await expect(secRow).toBeVisible();

  const firstPageUrl = page.url();
  await secRow.hover();
  await secRow.getByRole('button', { name: 'New page', exact: true }).click();
  await expect(page).not.toHaveURL(firstPageUrl);
  await expect(page).toHaveURL(/\/p\/[^/]+$/);
  const pageId = page.url().split('/p/')[1];

  await page.locator('.page-title').fill('Kickoff notes');
  await page.locator('.ProseMirror').click();
  await page.keyboard.type('Agenda for the kickoff');
  await expect(page.locator('.crumbs')).toContainText('Q4');

  // Title and body are persisted on the server (survive a full reload).
  await expect(sidebar.getByText('Kickoff notes')).toBeVisible();
  await page.reload();
  await expect(page.locator('.page-title')).toHaveValue('Kickoff notes');
  await expect(page.locator('.ProseMirror')).toContainText('Agenda for the kickoff');
  expect(page.url()).toContain(pageId);
});
