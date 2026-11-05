// Client error reporting (src/lib/errorReporting.ts → POST /api/client-errors). Owner: Observability.
// An uncaught error in the page is reported once (de-duplicated, query/fragment stripped), the server accepts it
// with 204, and noise is not reported. Signed in, the bearer token is attached.
import { expect, test, type Page, type Request } from '@playwright/test';
import { createPage, createUser, openPage, signInContext } from './helpers.ts';

/** Collect every client-error report the page sends (and let it through to the real server). */
function collect(page: Page) {
  const reqs: Request[] = [];
  const statuses: number[] = [];
  page.on('request', (r) => {
    if (r.url().endsWith('/api/client-errors')) reqs.push(r);
  });
  page.on('response', (r) => {
    if (r.url().endsWith('/api/client-errors')) statuses.push(r.status());
  });
  return { reqs, statuses };
}

const throwLater = (page: Page, message: string) => page.evaluate((m) => void setTimeout(() => { throw new Error(m); }, 0), message);

test('an uncaught error is reported once with the right shape; a repeat is de-duplicated; noise is ignored', async ({ page }) => {
  const { reqs, statuses } = collect(page);
  await page.goto('/login?utm=secret-query#frag');
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();

  const msg = `e2e boom ${Date.now()}`;
  await throwLater(page, msg);
  await expect.poll(() => reqs.length).toBe(1);
  await expect.poll(() => statuses).toEqual([204]);

  const r = reqs[0]!;
  expect(r.method()).toBe('POST');
  expect(r.headers()['authorization']).toBeUndefined(); // anonymous
  const body = r.postDataJSON() as Record<string, unknown>;
  expect(body).toMatchObject({ kind: 'error', message: expect.stringContaining(msg), version: expect.any(String) });
  expect(body.stack).toEqual(expect.stringContaining(msg));
  expect(String(body.url)).toMatch(/\/login$/); // no query string, no fragment
  expect(String(body.userAgent)).toContain('Chrome');
  for (const k of Object.keys(body)) expect(['col', 'componentStack', 'kind', 'line', 'message', 'source', 'stack', 'url', 'userAgent', 'version']).toContain(k); // nothing else is sent

  // Same error again, plus noise that must never be reported.
  await throwLater(page, msg);
  await page.evaluate(() => void setTimeout(() => { throw new Error('ResizeObserver loop completed with undelivered notifications.'); }, 0));
  await page.evaluate(() => void Promise.reject(new DOMException('The operation was aborted.', 'AbortError')));
  // A different error proves the page is still reporting (and gives the above time to have been sent, were it going to be).
  await throwLater(page, `${msg} second`);
  await expect.poll(() => reqs.length).toBe(2);
  expect((reqs[1]!.postDataJSON() as { message: string }).message).toContain('second');
  await page.waitForTimeout(500);
  expect(reqs.length).toBe(2);
});

test('signed in: the report carries the bearer token, and nothing is reported while offline', async ({ browser, request }) => {
  const user = await createUser(request, 'Err Reporter');
  const { pageId } = await createPage(request, user, { page: 'Reporting page' });
  const ctx = await browser.newContext();
  await signInContext(ctx, user);
  const page = await ctx.newPage();
  const { reqs, statuses } = collect(page);
  await openPage(page, user.wsId, pageId);

  await ctx.setOffline(true);
  await throwLater(page, `offline boom ${Date.now()}`);
  await page.waitForTimeout(500);
  expect(reqs.length).toBe(0);
  await ctx.setOffline(false);

  await throwLater(page, `online boom ${Date.now()}`);
  await expect.poll(() => reqs.length).toBe(1);
  await expect.poll(() => statuses).toEqual([204]);
  expect(reqs[0]!.headers()['authorization']).toMatch(/^Bearer \S+$/);
  expect(String(reqs[0]!.postDataJSON().url)).toContain(`/p/${pageId}`);
  await ctx.close();
});
