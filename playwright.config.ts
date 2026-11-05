// End-to-end tests (owner: QA). Run with `npm run test:e2e`.
// Starts the production server on a free port with a throwaway DATA_DIR.
// E2E_NO_BUILD=1 skips `npm run build` (reuse an existing dist/). E2E_BASE_URL points at a running server instead.
import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.E2E_PORT ?? 4317);
const external = process.env.E2E_BASE_URL;
const baseURL = external ?? `http://127.0.0.1:${PORT}`;
// Only the main process starts the server; workers just need the URL.
const dataDir = process.env.E2E_DATA_DIR ?? (process.env.TEST_WORKER_INDEX ? '' : mkdtempSync(join(tmpdir(), 'noteapp-e2e-')));
const ci = !!process.env.CI;

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
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: '**/*.mobile.spec.ts' },
    { name: 'mobile', use: { ...devices['iPhone 13'], browserName: 'chromium' }, testMatch: '**/*.mobile.spec.ts' },
  ],
  webServer: external
    ? undefined
    : {
        command: `${process.env.E2E_NO_BUILD ? '' : 'npm run build && '}npm start`,
        url: `${baseURL}/api/health`,
        timeout: 180_000,
        reuseExistingServer: false,
        stdout: 'ignore',
        stderr: 'pipe',
        env: {
          PORT: String(PORT),
          DATA_DIR: dataDir,
          JWT_SECRET: 'e2e-only-secret-not-used-anywhere-else',
          GIT_SHA: 'e2e',
        },
      },
});
