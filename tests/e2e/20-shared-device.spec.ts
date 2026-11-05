// Shared device: one person's locally cached notes and files must never be
// visible to the next person who signs in on the same browser (owner: Foundation).
import { expect, test } from '@playwright/test';
import { PASSWORD, createPage, createUser, openPage, signInContext } from './helpers.ts';

test('a different user signing in wipes the previous user’s local copies, even without a sign-out', async ({ browser, request }) => {
  const alice = await createUser(request, 'Alice Shared');
  const bob = await createUser(request, 'Bob Shared');
  const { pageId } = await createPage(request, alice, { page: 'Alice private-ish notes' });

  const ctx = await browser.newContext();
  await signInContext(ctx, alice);
  const page = await ctx.newPage();
  await openPage(page, alice.wsId, pageId);
  // Alice's note is cached locally (y-indexeddb) and a file of hers is in the uploads cache.
  await expect
    .poll(() => page.evaluate(async (id) => (await indexedDB.databases()).some((d) => d.name === `noteapp-page-${id}`), pageId))
    .toBe(true);
  await page.evaluate(async () => {
    const c = await caches.open('uploads-v1');
    await c.put('/uploads/alice-photo.png', new Response('alice'));
  });

  // The server errors at startup, so Alice's session ends without a sign-out (her data stays for now).
  await page.route('**/api/auth/refresh', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"down"}' }));
  await page.reload();
  await expect(page).toHaveURL(/\/login/);
  await page.unroute('**/api/auth/refresh');

  // Bob signs in on the same browser.
  await page.getByLabel('Email').fill(bob.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${bob.wsId}`));

  const left = await page.evaluate(
    async (id) => ({
      aliceNote: (await indexedDB.databases()).some((d) => d.name === `noteapp-page-${id}`),
      aliceFile: !!(await caches.match('/uploads/alice-photo.png')),
    }),
    pageId,
  );
  expect(left).toEqual({ aliceNote: false, aliceFile: false });
  await ctx.close();
});
