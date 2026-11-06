// Invite-only sign-up (#67), against a server in the production default SIGNUP_MODE=invite
// (`invite-only` project). The owner is bootstrapped through ADMIN_EMAILS, so tests are independent and retry-safe.
import { expect, test } from '@playwright/test';
import { PASSWORD, api, uniqueEmail } from './helpers.ts';

const OWNER_EMAIL = 'gate-owner@e2e.test'; // in ADMIN_EMAILS on the invite-only server (bootstrap)

/** Signs up the admin-listed owner once (retry-safe: logs in if it already exists). */
async function owner(request: import('@playwright/test').APIRequestContext) {
  let res = await request.post('/api/auth/register', { data: { name: 'Gate Owner', email: OWNER_EMAIL, password: PASSWORD } });
  if (res.status() === 409) res = await request.post('/api/auth/login', { data: { email: OWNER_EMAIL, password: PASSWORD } });
  expect(res.ok(), await res.text()).toBe(true);
  const s = (await res.json()) as { accessToken: string };
  return { token: s.accessToken };
}

test('an email listed in ADMIN_EMAILS can always sign up (bootstrap)', async ({ request }) => {
  const o = await owner(request);
  expect(o.token).toBeTruthy();
});

test('once the server has an account, strangers cannot sign up (UI explains, API refuses)', async ({ page, request }) => {
  await owner(request); // a server with no accounts at all still allows the first sign-up
  await page.goto('/login');
  await expect(page.getByText('Sign-up is by invitation')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create an account' })).toHaveCount(0);
  const res = await request.post('/api/auth/register', { data: { name: 'Stranger', email: uniqueEmail('stranger'), password: PASSWORD } });
  expect(res.status()).toBe(403);
  expect(await res.text()).toContain('invitation');
});

test('an invited email can sign up through the invite link', async ({ browser, request }) => {
  const o = await owner(request);
  const email = uniqueEmail('invited');
  const { id: teamId } = await api<{ id: string }>(request, 'POST', '/workspaces', o.token, { name: 'Gated Team' });
  const r = await api<{ inviteUrl?: string }>(request, 'POST', `/workspaces/${teamId}/members`, o.token, { email, role: 'member' });

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(new URL(r.inviteUrl!).pathname);
  await page.getByRole('button', { name: 'Sign in or create an account' }).click();
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Name').fill('Invited Ivan');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${teamId}`));
  await expect(page.locator('.ws-switch')).toContainText('Gated Team');
  await ctx.close();

  // The invite is used up: a different stranger still can't register.
  expect((await request.post('/api/auth/register', { data: { name: 'Late', email: uniqueEmail('late'), password: PASSWORD } })).status()).toBe(403);
});
