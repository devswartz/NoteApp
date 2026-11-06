// @mentions in page text: typing "@" opens the member picker, Enter inserts a
// mention chip, it survives a reload, and the mentioned person gets notified.
import { expect, test } from '@playwright/test';
import { api, createPage, createTeam, createUser, eventually, focusEnd, openPage, signInContext } from './helpers.ts';

test('@mention a teammate in a page: picker, chip, persisted, notified', async ({ browser, request }) => {
  const alice = await createUser(request, 'Alice Writer');
  const bob = await createUser(request, 'Bob Mentioned');
  const teamId = await createTeam(request, alice, [{ user: bob, role: 'member' }]);
  const { pageId } = await createPage(request, alice, { wsId: teamId, page: 'Standup notes' });

  const context = await browser.newContext();
  await signInContext(context, alice);
  const page = await context.newPage();
  await openPage(page, teamId, pageId);

  await focusEnd(page);
  await page.keyboard.type('Ask @Bo');
  const pop = page.locator('.mention-pop');
  await expect(pop.locator('.mention-item', { hasText: 'Bob Mentioned' })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(pop).toHaveCount(0);
  await page.keyboard.type('about the release');

  const chip = page.locator('.ProseMirror .mention');
  await expect(chip).toHaveText('@Bob Mentioned');
  await expect(chip).toHaveAttribute('data-id', bob.id);
  await expect(page.locator('.ProseMirror')).toContainText('Ask @Bob Mentioned about the release');

  // Escape closes the picker and leaves the typed text alone.
  await page.keyboard.press('Enter');
  await page.keyboard.type('cc @Bo');
  await expect(pop).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(pop).toHaveCount(0);
  await expect(page.locator('.ProseMirror .mention')).toHaveCount(1);

  // The server notifies Bob once the page is saved.
  await eventually(
    () => api<{ items: { kind: string; title: string }[] }>(request, 'GET', '/notifications', bob.token),
    (r) => r.items.some((n) => n.kind === 'mention' && n.title.includes('Standup notes')),
    'Bob is notified of the mention',
  );

  await page.reload();
  await expect(page.locator('.ProseMirror .mention')).toHaveText('@Bob Mentioned');
  await context.close();
});
