// Priority 8: offline — edit a page while offline, reconnect, and the edits sync to the server and other users.
import { expect, test, type WebSocketRoute } from '@playwright/test';
import { createPage, createUser, focusEnd, openPage, signInContext } from './helpers.ts';

test('edits made offline sync when the connection comes back', async ({ browser, request }) => {
  const user = await createUser(request, 'Otto Offline');
  const { pageId } = await createPage(request, user, { page: 'Field notes' });

  const ctx = await browser.newContext();
  await signInContext(ctx, user);
  const page = await ctx.newPage();
  // Chromium's offline emulation leaves open WebSockets alone, so proxy the collab socket and cut it ourselves:
  // while "offline", live sockets are closed and reconnects are refused, like a dropped network.
  let offline = false;
  const sockets = new Set<WebSocketRoute>();
  await page.routeWebSocket(/\/collab\//, (ws) => {
    if (offline) return void ws.close({ code: 4000, reason: 'e2e offline' });
    ws.connectToServer();
    sockets.add(ws);
  });
  const editor = await openPage(page, user.wsId, pageId);
  await focusEnd(page);
  await page.keyboard.type('Online line.');

  // A second viewer (same user, other device) to see the sync arrive.
  const ctx2 = await browser.newContext();
  await signInContext(ctx2, { ...user, refreshToken: await freshRefreshToken(request, user.email) });
  const other = await ctx2.newPage();
  const otherEditor = await openPage(other, user.wsId, pageId);
  await expect(otherEditor).toContainText('Online line.');

  offline = true;
  await ctx.setOffline(true);
  for (const ws of sockets) await ws.close({ code: 4000, reason: 'e2e offline' });
  sockets.clear();
  await expect(page.locator('.offline-banner')).toBeVisible();
  await expect(page.locator('.sync-offline, .sync-connecting')).toBeVisible();

  await focusEnd(page);
  await page.keyboard.press('Enter');
  await page.keyboard.type('Written while offline.');
  await expect(editor).toContainText('Written while offline.');
  await expect(otherEditor).not.toContainText('Written while offline.');

  offline = false;
  await ctx.setOffline(false);
  await expect(page.locator('.offline-banner')).toHaveCount(0);
  await expect(page.locator('.sync-live')).toBeVisible({ timeout: 20_000 });
  await expect(otherEditor).toContainText('Written while offline.');

  // And it reached the server: a fresh load shows it.
  await other.reload();
  await expect(other.locator('.ProseMirror')).toContainText('Written while offline.');
  await ctx.close();
  await ctx2.close();
});

test('a page opened before going offline still opens after a reload while offline', async ({ browser, request }) => {
  test.fixme(true, 'BUG-1 (docs/QA.md): reloading while offline shows the login screen instead of the cached note');
  const user = await createUser(request, 'Olive Cache');
  const { pageId } = await createPage(request, user, { page: 'Cached page' });
  const ctx = await browser.newContext();
  await signInContext(ctx, user);
  const page = await ctx.newPage();
  const editor = await openPage(page, user.wsId, pageId);
  await focusEnd(page);
  await page.keyboard.type('Readable without a network.');
  // Let the service worker take control so the app shell is cached.
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null || navigator.serviceWorker?.ready.then(() => true), null, { timeout: 10_000 });
  await page.reload();
  await expect(editor).toContainText('Readable without a network.');

  await ctx.setOffline(true);
  await page.reload();
  await expect(page.locator('.ProseMirror')).toContainText('Readable without a network.', { timeout: 15_000 });
  await expect(page.locator('.offline-banner')).toBeVisible();
  await ctx.close();
});

async function freshRefreshToken(request: import('@playwright/test').APIRequestContext, email: string) {
  const res = await request.post('/api/auth/login', { data: { email, password: (await import('./helpers.ts')).PASSWORD } });
  return ((await res.json()) as { refreshToken: string }).refreshToken;
}
