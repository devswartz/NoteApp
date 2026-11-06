// Email verification × invites (`verify-email` project): an invited person who signs up must confirm their email
// first; only then are their pending invites applied (server/verification.ts → consumeVerificationToken).
import { expect, test, type APIRequestContext } from '@playwright/test';
import { PASSWORD, api, uniqueEmail } from './helpers.ts';

// In ADMIN_EMAILS on the verify-email server, so it starts verified (see playwright.config.ts).
const ADMIN = 'feedback-admin@e2e.test';

async function adminToken(request: APIRequestContext) {
  let res = await request.post('/api/auth/register', { data: { name: 'Feedback Admin', email: ADMIN, password: PASSWORD } });
  if (res.status() === 409) res = await request.post('/api/auth/login', { data: { email: ADMIN, password: PASSWORD } });
  expect(res.ok(), await res.text()).toBe(true);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

async function confirmationLink(request: APIRequestContext, email: string) {
  let link = '';
  await expect
    .poll(async () => {
      const msgs = (await (await request.get(`/api/__test/outbox?to=${encodeURIComponent(email)}`)).json()) as { subject: string; text: string }[];
      const m = msgs.filter((x) => x.subject.startsWith('Confirm your email for ')).pop();
      link = m ? /(https?:\/\/\S+\/verify-email\?token=[\w-]+)/.exec(m.text)![1]! : '';
      return link;
    }, { message: `confirmation email to ${email}` })
    .not.toBe('');
  return link;
}

test('invited, signs up unverified → no access yet → confirms → invite applied, lands in the team', async ({ page, request }) => {
  const token = await adminToken(request);
  const { id: teamId } = await api<{ id: string }>(request, 'POST', '/workspaces', token, { name: 'Verified Team' });
  const email = uniqueEmail('invited-unverified');
  await api(request, 'POST', `/workspaces/${teamId}/members`, token, { email, role: 'member' });

  // Sign up from the plain login page (not the invite link).
  await page.goto('/login');
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Name').fill('Una Unverified');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

  // Not a member yet: the invite is still pending.
  const before = await api<{ members: { email: string }[]; invites: { email: string }[] }>(request, 'GET', `/workspaces/${teamId}/members`, token);
  expect(before.members.map((m) => m.email)).not.toContain(email);
  expect(before.invites.map((i) => i.email)).toContain(email);
  // And the team page isn't reachable while unverified.
  await page.goto(`/w/${teamId}`);
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

  // Confirm → the app opens; the invite has turned into a membership.
  await page.goto(await confirmationLink(request, email));
  await expect(page.getByRole('heading', { name: 'Email confirmed' })).toBeVisible();
  await expect(page).toHaveURL(/\/w\//, { timeout: 15_000 });
  const after = await api<{ members: { email: string; role: string }[]; invites: { email: string }[] }>(request, 'GET', `/workspaces/${teamId}/members`, token);
  expect(after.members.find((m) => m.email === email)?.role).toBe('member');
  expect(after.invites.map((i) => i.email)).not.toContain(email);

  await page.locator('.ws-switch').click();
  await page.locator('.menu').getByRole('menuitem', { name: /Verified Team/ }).click();
  await expect(page.locator('.ws-switch')).toContainText('Verified Team');
});
