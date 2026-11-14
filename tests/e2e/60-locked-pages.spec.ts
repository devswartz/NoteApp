// Locked pages (server/locks.ts, src/components/LockedNotes.tsx): set the locked-notes password while locking a page,
// relock, unlock from the lock screen, remove the lock; another member never sees the page while it is locked.
import { expect, test, type Page } from '@playwright/test';
import { api, createPage, createTeam, createUser, firstEditor, openPage, pageUrl, signInContext } from './helpers.ts';

const LOCK_PW = 'locked-e2e-pw';

const pageMenu = async (page: Page) => {
  await page.locator('.page-topbar').getByRole('button', { name: 'Page options' }).click();
  return page.locator('.page-menu');
};

test('set password → lock → relock → unlock → remove lock; another member never sees it while locked', async ({ page, browser, context, request }) => {
  const owner = await createUser(request, 'Lena Locker');
  const other = await createUser(request, 'Max Member');
  const ws = await createTeam(request, owner, [{ user: other, role: 'admin' }], 'Lock Team');
  // Only a page nobody else can see can be locked: a page in a shared notebook offers it disabled, with the reason.
  const team = await createPage(request, owner, { wsId: ws, notebook: 'Team notes', page: 'Team page' });
  const { pageId } = await createPage(request, owner, { wsId: ws, notebook: 'Journal', page: 'Secret plans', visibility: 'private' });
  await signInContext(context, owner);

  await openPage(page, ws, team.pageId);
  const teamLock = (await pageMenu(page)).getByRole('menuitem', { name: /Lock page/ });
  await expect(teamLock).toHaveAttribute('aria-disabled', 'true');
  await expect(teamLock).toContainText('Only pages only you can see can be locked');
  await page.keyboard.press('Escape');

  // Write something on the page.
  const editor = await openPage(page, ws, pageId);
  await editor.click();
  await page.keyboard.type('The launch is on Friday');
  await expect(page.locator('.sync-live')).toBeVisible();
  await expect.poll(async () => (await api<{ ydoc: string }>(request, 'GET', `/pages/${pageId}/doc`, owner.token)).ydoc.length).toBeGreaterThan(40);

  // Lock it: no locked-notes password yet, so one is created on the way (twice, to confirm).
  await (await pageMenu(page)).getByRole('menuitem', { name: /^Lock page/ }).click();
  await page.getByRole('dialog').locator('input').fill(LOCK_PW);
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('dialog', { name: 'Create a locked-notes password' }).locator('input').fill(LOCK_PW);
  await page.getByRole('button', { name: 'Save password' }).click();
  await expect(page.getByText('Page locked.')).toBeVisible();
  await expect(page.locator('.sb-row.page-row', { hasText: 'Secret plans' }).locator('.sb-lock-icon')).toBeVisible();

  // The other member (an admin) doesn't have it anywhere: not in the tree, not by link.
  const bc = await browser.newContext();
  await signInContext(bc, other);
  const op = await bc.newPage();
  await op.goto(pageUrl(ws, pageId));
  await expect(op.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect(op.locator('.sb-row.page-row', { hasText: 'Secret plans' })).toHaveCount(0);

  // Lock now: the lock screen, with the title and nothing of the content.
  await (await pageMenu(page)).getByRole('menuitem', { name: 'Lock now' }).click();
  const lock = page.getByRole('region', { name: 'Locked page' });
  await expect(lock).toBeVisible();
  await expect(lock.getByRole('heading', { name: 'Secret plans' })).toBeVisible();
  await expect(page.getByText('The launch is on Friday')).toHaveCount(0);

  // A wrong password is refused; the right one opens it.
  await lock.locator('input[type=password]').fill('not-it');
  await lock.getByRole('button', { name: 'Unlock' }).click();
  await expect(lock.getByText('That password isn’t right.')).toBeVisible();
  await lock.locator('input[type=password]').fill(LOCK_PW);
  await lock.getByRole('button', { name: 'Unlock' }).click();
  await expect(firstEditor(page)).toContainText('The launch is on Friday');
  await expect(lock).toHaveCount(0);

  // Remove the lock (needs the password): an ordinary private page again.
  await (await pageMenu(page)).getByRole('menuitem', { name: 'Remove lock…' }).click();
  await page.getByRole('dialog').locator('input').fill(LOCK_PW);
  await page.getByRole('button', { name: 'Remove lock' }).click();
  await expect(page.getByText('Lock removed')).toBeVisible();
  await expect(page.locator('.sb-row.page-row', { hasText: 'Secret plans' }).locator('.sb-lock-icon')).toHaveCount(0);
  await bc.close();
});
