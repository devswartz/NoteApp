// AI connectors (server/oauth/): a signed-out user starts an app's connect flow, signs in, sees the consent
// page (app name marked as self-reported, permissions in plain words), allows read only, and is sent back to
// the app with a code. Settings → Connected apps then lists the app, and Revoke ends its access.
import { expect, test } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { PASSWORD, createUser } from './helpers.ts';

const REDIRECT = 'https://client.e2e.example/callback';

test('connect an AI app: sign in, consent, then revoke it in Settings', async ({ page, request, baseURL }) => {
  const user = await createUser(request, 'Connie Nector');
  const reg = await request.post('/oauth/register', { data: { client_name: 'E2E Assistant', redirect_uris: [REDIRECT] } });
  expect(reg.status()).toBe(201);
  const clientId = (await reg.json()).client_id as string;

  // The app's callback: just a page that shows what it received.
  await page.route('https://client.e2e.example/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Callback</h1>' }));

  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'notes:read notes:write',
    state: 'e2e-state',
    resource: `${baseURL}/mcp`,
  });
  await page.goto(`/oauth/authorize?${q}`);

  // Signed out: the normal sign-in, which says why.
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByText('Sign in to finish connecting an app')).toBeVisible();
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // Back on the consent page.
  await expect(page).toHaveURL(/\/oauth\/consent\?request=/);
  await expect(page.getByRole('heading', { name: /Allow “E2E Assistant” to use your/ })).toBeVisible();
  await expect(page.getByText(/provided by the app itself.*hasn’t verified it/)).toBeVisible();
  await expect(page.getByText('client.e2e.example', { exact: true })).toBeVisible();
  await expect(page.getByText('Read your notes')).toBeVisible();
  const write = page.getByRole('checkbox', { name: /Create and edit notes/ });
  await expect(write).toBeChecked();
  await write.uncheck(); // allow reading only
  await page.getByRole('button', { name: 'Allow' }).click();

  await page.waitForURL(/^https:\/\/client\.e2e\.example\/callback\?/);
  const back = new URL(page.url());
  expect(back.searchParams.get('state')).toBe('e2e-state');
  const code = back.searchParams.get('code')!;
  expect(code).toBeTruthy();

  const tok = await request.post('/oauth/token', {
    form: { grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier, resource: `${baseURL}/mcp` },
  });
  expect(tok.status()).toBe(200);
  const tokens = await tok.json();
  expect(tokens.scope).toBe('notes:read');

  // Settings → Connected apps.
  await page.goto(`/w/${user.wsId}/settings?s=connected-apps`);
  await expect(page.getByRole('heading', { name: 'Connected apps', level: 1 })).toBeVisible();
  await expect(page.getByText('E2E Assistant')).toBeVisible();
  await expect(page.getByText('Read your notes only')).toBeVisible();
  await expect(page.getByText(/Connected .* · Not used yet/)).toBeVisible();
  await page.getByRole('button', { name: 'Revoke E2E Assistant' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByText('No apps are connected.')).toBeVisible();

  // Its refresh token no longer works.
  const r = await request.post('/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId } });
  expect(r.status()).toBe(400);
});

test('a request with an unregistered redirect address is stopped on Notivelo, not sent on', async ({ page, request }) => {
  const reg = await request.post('/oauth/register', { data: { client_name: 'Sneaky', redirect_uris: [REDIRECT] } });
  const clientId = (await reg.json()).client_id as string;
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: 'https://attacker.e2e.example/cb', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' });
  await page.goto(`/oauth/authorize?${q}`);
  await expect(page).toHaveURL(/\/oauth\/consent\?error=invalid_redirect_uri/);
  await expect(page.getByRole('heading', { name: 'Can’t connect this app' })).toBeVisible();
});
