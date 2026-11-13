// The two lower-left menus open different settings pages: the workspace menu → Workspace settings
// (General, Members, Teams, Tags), the avatar menu → Settings (Account and App sections).
import { expect, test, type Page } from '@playwright/test';
import { createUser, signInContext } from './helpers.ts';

const nav = (page: Page) => page.getByRole('navigation', { name: 'Settings sections' });
const WORKSPACE = ['General', 'Members', 'Teams', 'Tags'];
const PERSONAL = ['Profile', 'Appearance', 'Notifications', 'Keyboard shortcuts', 'About'];

async function expectSections(page: Page, shown: string[], hidden: string[]) {
  for (const s of shown) await expect(nav(page).getByRole('button', { name: s, exact: true })).toBeVisible();
  for (const s of hidden) await expect(nav(page).getByRole('button', { name: s, exact: true })).toHaveCount(0);
}

test('each lower-left menu opens a settings page listing only its own sections', async ({ page, context, request }) => {
  const user = await createUser(request, 'Sela Scope');
  await signInContext(context, user);
  await page.goto(`/w/${user.wsId}/notes`);
  const wsName = (await page.locator('.ws-switch .truncate, .ws-switch-compact .sr-only').first().innerText()).trim();

  // Workspace menu: Workspace settings, Activity, Trash; no Sign out.
  await page.locator('.ws-switch').first().click();
  await expect(page.getByRole('menuitem', { name: 'Activity' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Trash' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Sign out' })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Workspace settings' }).click();
  await expect(page).toHaveURL(/scope=workspace/);
  await expectSections(page, WORKSPACE, PERSONAL);
  await expect(page.locator('.settings-side-title')).toHaveText(`${wsName} settings`);
  await expect(page.getByRole('heading', { name: 'General', level: 1 })).toBeVisible();

  // Personal menu: Settings, Keyboard shortcuts, Sign out; no Activity / Trash.
  await page.getByRole('button', { name: 'Account and settings' }).click();
  await expect(page.getByRole('menuitem', { name: 'Keyboard shortcuts' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Activity' })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Trash' })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/scope=personal/);
  await expectSections(page, PERSONAL, WORKSPACE);
  await expect(page.locator('.settings-side-title')).toHaveText('Settings');
  await expect(page.getByRole('heading', { name: 'Profile', level: 1 })).toBeVisible();

  // Old links to a section open the page that section belongs to.
  await page.goto(`/w/${user.wsId}/settings?s=members`);
  await expectSections(page, WORKSPACE, PERSONAL);
  await expect(page.getByRole('heading', { name: 'Members', level: 1 })).toBeVisible();
  await page.goto(`/w/${user.wsId}/settings?s=appearance`);
  await expectSections(page, PERSONAL, WORKSPACE);
  await expect(page.getByRole('heading', { name: 'Appearance', level: 1 })).toBeVisible();
});
