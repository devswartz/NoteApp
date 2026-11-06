// Following a collaborator (#39): click their avatar and their cursor stays in view as they
// move; scrolling yourself stops following.
import { expect, test, type Browser } from '@playwright/test';
import { createPage, createTeam, createUser, focusEnd, openPage, signInContext, type TestUser } from './helpers.ts';

async function userPage(browser: Browser, user: TestUser) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 700 } });
  await signInContext(context, user);
  return { context, page: await context.newPage() };
}

test('follow a collaborator’s cursor, and stop by scrolling', async ({ browser, request }) => {
  const ann = await createUser(request, 'Ann Follower');
  const bob = await createUser(request, 'Bob Leader');
  const teamId = await createTeam(request, ann, [{ user: bob, role: 'member' }], 'Follow Team');
  const { pageId } = await createPage(request, ann, { wsId: teamId, page: 'Long doc' });

  const a = await userPage(browser, ann);
  const b = await userPage(browser, bob);
  await openPage(a.page, teamId, pageId);
  await openPage(b.page, teamId, pageId);

  // Bob writes a long page and ends up far below Ann's view.
  await focusEnd(b.page);
  for (let i = 1; i <= 45; i++) {
    await b.page.keyboard.type(`Line ${i}`);
    await b.page.keyboard.press('Enter');
  }
  await b.page.keyboard.type('Bob is down here');
  await expect(a.page.locator('.ProseMirror')).toContainText('Bob is down here');
  const bobCaret = a.page.locator(`.collaboration-carets__caret[data-user-id="${bob.id}"]`);
  await expect(bobCaret).toBeAttached();
  await a.page.locator('.page-scroll').evaluate((el) => el.scrollTo(0, 0));
  await expect(bobCaret).not.toBeInViewport();

  // Ann clicks Bob's avatar: his caret comes into view and the banner says she's following.
  await a.page.locator('button.presence-avatar[title="Bob Leader — click to jump to them"]').click();
  await expect(a.page.locator('.follow-banner')).toContainText('Following Bob Leader');
  await expect(bobCaret).toBeInViewport({ timeout: 5000 });

  // Bob jumps to the top and types: Ann's view follows him there.
  await b.page.keyboard.press('ControlOrMeta+Home');
  await b.page.keyboard.type('Back at the top ');
  await expect(a.page.locator('.ProseMirror')).toContainText('Back at the top');
  await expect(bobCaret).toBeInViewport({ timeout: 5000 });

  // Ann scrolls herself: following stops.
  await a.page.locator('.page-article').hover();
  await a.page.mouse.wheel(0, 400);
  await expect(a.page.locator('.follow-banner')).toHaveCount(0);

  await a.context.close();
  await b.context.close();
});
