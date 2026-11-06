// Email verification for sign-up, against a server started for the `verify-email` project (see playwright.config.ts):
// SIGNUP_MODE=open with NO SMTP, so the confirmation emails land in the mail outbox, which the test-only hook
// GET /api/__test/outbox exposes. The hook exists only with E2E_TEST_HOOKS=1 and NODE_ENV != production
// (server/verification.ts, tests/email-verification.test.ts), and that server is what makes verification
// required without SMTP. (Every other project has no SMTP either, so there everyone is auto-verified.)
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { PASSWORD, uniqueEmail } from './helpers.ts';

/** Confirmation links emailed to `email`, oldest first. */
async function links(request: APIRequestContext, email: string): Promise<string[]> {
  const res = await request.get(`/api/__test/outbox?to=${encodeURIComponent(email)}`);
  expect(res.ok(), await res.text()).toBe(true);
  const msgs = (await res.json()) as { subject: string; text: string }[];
  return msgs.filter((m) => m.subject.startsWith('Confirm your email for ')).map((m) => /(https?:\/\/\S+\/verify-email\?token=[\w-]+)/.exec(m.text)![1]!);
}
async function waitForLinks(request: APIRequestContext, email: string, n: number): Promise<string[]> {
  await expect.poll(async () => (await links(request, email)).length, { message: `${n} confirmation email(s) to ${email}` }).toBeGreaterThanOrEqual(n);
  return links(request, email);
}

async function register(page: Page, name: string, email: string) {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
}

// The very first account on a server is a bootstrap account and is auto-verified, so make sure it isn't one of ours.
test.beforeAll(async ({ request }) => {
  await request.post('/api/auth/register', { data: { name: 'Bootstrap', email: uniqueEmail('bootstrap'), password: PASSWORD } });
});

test('sign up → check your email → resend (cooldown, old link dead) → confirm link opens the app', async ({ page, browser, request }) => {
  const email = uniqueEmail('verify');
  await register(page, 'Vera Verify', email);
  await expect(page.getByText(email)).toBeVisible();
  await expect(page.locator('.sidebar, .ws-switch')).toHaveCount(0); // none of the app is reachable

  const [first] = await waitForLinks(request, email, 1);
  await page.getByRole('button', { name: 'Resend email' }).click();
  await expect(page.getByText(/We sent a new link/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Resend email \(\d+s\)/ })).toBeDisabled(); // cooldown
  const all = await waitForLinks(request, email, 2);
  const second = all[1]!;
  expect(second).not.toBe(first);

  // The first link was replaced by the second.
  const other = await browser.newContext();
  const stale = await other.newPage();
  await stale.goto(first);
  await expect(stale.getByRole('heading', { name: 'Link not valid' })).toBeVisible();
  await other.close();

  // The new link, opened in the signed-in browser, confirms and lands in the app.
  await page.goto(second);
  await expect(page.getByRole('heading', { name: 'Email confirmed' })).toBeVisible();
  await expect(page).toHaveURL(/\/w\//, { timeout: 15_000 });
  await expect(page.locator('.ws-switch')).toBeVisible();

  // Links are single use.
  const again = await browser.newContext();
  const reuse = await again.newPage();
  await reuse.goto(second);
  await expect(reuse.getByRole('heading', { name: 'Link not valid' })).toBeVisible();
  await again.close();
});

test('"I\'ve verified, continue" re-checks: refused until the email is confirmed elsewhere, then opens the app', async ({ page, request }) => {
  const email = uniqueEmail('continue');
  await register(page, 'Colin Continue', email);
  await page.getByRole('button', { name: "I've verified, continue" }).click();
  await expect(page.getByText(/Not confirmed yet/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

  const [link] = await waitForLinks(request, email, 1);
  const token = new URL(link!).searchParams.get('token');
  const res = await request.post('/api/auth/verify-email', { data: { token } }); // "on another device"
  expect(res.ok(), await res.text()).toBe(true);

  await page.getByRole('button', { name: "I've verified, continue" }).click();
  await expect(page).toHaveURL(/\/w\//);
  await expect(page.locator('.ws-switch')).toBeVisible();
});

test('the link works when signed out, then sign in; unverified sign-in shows the check-your-email screen; sign out works', async ({ page, browser, request }) => {
  const email = uniqueEmail('signedout');
  const reg = await request.post('/api/auth/register', { data: { name: 'Sigrid Out', email, password: PASSWORD } });
  expect(reg.ok()).toBe(true);
  expect(((await reg.json()) as { user: { emailVerified: boolean } }).user.emailVerified).toBe(false);

  // Signing in unverified: only the check-your-email screen, and Sign out returns to the login page.
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await page.goto('/w/anything/tasks/today'); // deep links don't get around it
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);

  // The emailed link, opened with no session at all.
  const [link] = await waitForLinks(request, email, 1);
  const ctx = await browser.newContext();
  const out = await ctx.newPage();
  await out.goto(link!);
  await expect(out.getByRole('heading', { name: 'Email confirmed' })).toBeVisible();
  await expect(out).toHaveURL(/\/login/, { timeout: 15_000 }); // routes on to the login page by itself
  await out.getByLabel('Email').fill(email);
  await out.getByLabel('Password').fill(PASSWORD);
  await out.getByRole('button', { name: 'Sign in' }).click();
  await expect(out).toHaveURL(/\/w\//);
  await ctx.close();
});
