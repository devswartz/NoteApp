// End-to-end tests (owner: QA). Run with `npm run test:e2e`.
// Starts the production server on a free port with a throwaway DATA_DIR.
// E2E_NO_BUILD=1 skips `npm run build` (reuse an existing dist/). E2E_BASE_URL points at a running server instead.
//
// A second server (PORT+1) runs with very short access tokens (ACCESS_TOKEN_TTL_S) for the
// `short-tokens` project (*.tokens.spec.ts), which checks that refresh works mid-session.
// A third server (PORT+2) runs the production default SIGNUP_MODE=invite for the `invite-only`
// project (*.invite.spec.ts). The main and short-token servers use SIGNUP_MODE=open so tests can create users freely.
import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.E2E_PORT ?? 4317);
const SHORT_PORT = PORT + 1;
const SHORT_TOKEN_TTL_S = 6;
const external = process.env.E2E_BASE_URL;
const baseURL = external ?? `http://127.0.0.1:${PORT}`;
const shortURL = `http://127.0.0.1:${SHORT_PORT}`;
const INVITE_PORT = PORT + 2;
const inviteURL = `http://127.0.0.1:${INVITE_PORT}`;
// Only the main process starts the servers; workers just need the URLs.
const tmp = () => (process.env.TEST_WORKER_INDEX ? '' : mkdtempSync(join(tmpdir(), 'noteapp-e2e-')));
const dataDir = process.env.E2E_DATA_DIR ?? tmp();
const shortDataDir = tmp();
const inviteDataDir = tmp();
// A fourth server (PORT+3) for the `verify-email` project (*.verify.spec.ts): email verification is only required
// when mail can be sent, so it runs with the test-only hooks (E2E_TEST_HOOKS=1, which the server ignores in
// production): verification required without SMTP, and the mail outbox readable over HTTP. It must not run with
// NODE_ENV=production, so it doesn't use `npm start`. E2E_VERIFY_URL points the project at a server you started yourself.
const VERIFY_PORT = PORT + 3;
const verifyURL = process.env.E2E_VERIFY_URL ?? `http://127.0.0.1:${VERIFY_PORT}`;
const verifyDataDir = tmp();
const ci = !!process.env.CI;
// SIGNUP_MODE=open: tests create many users directly (production defaults to invite-only).
const serverEnv = { JWT_SECRET: 'e2e-only-secret-not-used-anywhere-else-0123456789', GIT_SHA: 'e2e', SIGNUP_MODE: 'open' };

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  workers: ci ? 2 : undefined,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: ci ? [['list'], ['html', { open: 'never' }], ['github']] : [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Make "today" deterministic relative to the server and browser.
    timezoneId: 'UTC',
    locale: 'en-US',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: ['**/*.mobile.spec.ts', '**/*.tokens.spec.ts', '**/*.invite.spec.ts', '**/*.verify.spec.ts'] },
    { name: 'mobile', use: { ...devices['iPhone 13'], browserName: 'chromium' }, testMatch: '**/*.mobile.spec.ts' },
    ...(external && !process.env.E2E_VERIFY_URL
      ? []
      : [{ name: 'verify-email', use: { ...devices['Desktop Chrome'], baseURL: verifyURL }, testMatch: '**/*.verify.spec.ts' }]),
    ...(external
      ? []
      : [
          { name: 'short-tokens', use: { ...devices['Desktop Chrome'], baseURL: shortURL }, testMatch: '**/*.tokens.spec.ts' },
          { name: 'invite-only', use: { ...devices['Desktop Chrome'], baseURL: inviteURL }, testMatch: '**/*.invite.spec.ts' },
        ]),
  ],
  // Servers start one after the other, so only the first one builds.
  webServer: external
    ? undefined
    : [
        {
          command: `${process.env.E2E_NO_BUILD ? '' : 'npm run build && '}npm start`,
          url: `${baseURL}/api/health`,
          timeout: 180_000,
          reuseExistingServer: false,
          stdout: 'ignore',
          stderr: 'pipe',
          env: { ...serverEnv, PORT: String(PORT), DATA_DIR: dataDir, PUBLIC_URL: baseURL },
        },
        {
          command: 'npm start',
          url: `${shortURL}/api/health`,
          timeout: 60_000,
          reuseExistingServer: false,
          stdout: 'ignore',
          stderr: 'pipe',
          env: { ...serverEnv, PORT: String(SHORT_PORT), DATA_DIR: shortDataDir, PUBLIC_URL: shortURL, ACCESS_TOKEN_TTL_S: String(SHORT_TOKEN_TTL_S) },
        },
        {
          command: 'npm start',
          url: `${inviteURL}/api/health`,
          timeout: 60_000,
          reuseExistingServer: false,
          stdout: 'ignore',
          stderr: 'pipe',
          env: { ...serverEnv, SIGNUP_MODE: 'invite', ADMIN_EMAILS: 'gate-owner@e2e.test', PORT: String(INVITE_PORT), DATA_DIR: inviteDataDir, PUBLIC_URL: inviteURL },
        },
        {
          command: 'npx tsx server/index.ts',
          url: `${verifyURL}/api/health`,
          timeout: 60_000,
          reuseExistingServer: false,
          stdout: 'ignore',
          stderr: 'pipe',
          env: { ...serverEnv, NODE_ENV: 'test', E2E_TEST_HOOKS: '1', MAIL_QUIET: '1', ADMIN_EMAILS: 'feedback-admin@e2e.test' /* feedback mail recipient, see 24-feedback.verify.spec.ts */, PORT: String(VERIFY_PORT), DATA_DIR: verifyDataDir, PUBLIC_URL: verifyURL },
        },
      ],
});
