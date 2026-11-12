// Public /privacy and /terms pages (legal/*.md): reachable signed out by plain URL, linked from the login screen.
import { expect, test } from '@playwright/test';

test('/privacy and /terms open signed out, with headings and the contact address', async ({ page }) => {
  await page.goto('/privacy');
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Privacy Policy' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'What we keep about you' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'support@devswartz.com' }).first()).toBeVisible();
  await expect(page.locator('body')).not.toContainText('{{');
  await expect(page.locator('body')).not.toContainText('TODO');

  await page.goto('/terms');
  await expect(page).toHaveURL(/\/terms$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Terms of Service' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Privacy Policy' })).toBeVisible();
});

test('the login screen links to the Privacy and Terms pages, and sign-up states the agreement', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('link', { name: 'Terms', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Terms of Service' })).toBeVisible();
  await page.goto('/login');
  await page.getByRole('link', { name: 'Privacy', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Privacy Policy' })).toBeVisible();

  await page.goto('/login');
  await page.getByRole('button', { name: 'Create an account' }).click();
  await expect(page.getByText('By creating an account you agree to the')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Privacy Policy' })).toBeVisible();
});
