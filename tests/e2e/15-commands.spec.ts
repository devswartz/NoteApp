// Command palette commands and keyboard shortcuts from the central registry (#19).
import { expect, test } from '@playwright/test';
import { createUser, signInContext, tasksUrl } from './helpers.ts';

test('palette runs commands; "g" shortcuts navigate; "?" lists the shortcuts', async ({ page, context, request }) => {
  const user = await createUser(request, 'Pat Palette');
  await signInContext(context, user);
  await page.goto(tasksUrl(user.wsId, 'today'));
  await expect(page.getByRole('heading', { name: 'Today', level: 1 })).toBeVisible();

  // Palette → "Go to Upcoming".
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: 'Search' });
  await palette.getByPlaceholder(/Search pages and tasks/).fill('upcoming');
  await expect(palette.locator('.palette-label', { hasText: 'Go to Upcoming' })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/tasks\/upcoming$/);
  await expect(palette).toHaveCount(0);

  // Two-key navigation.
  await page.keyboard.press('g');
  await page.keyboard.press('c');
  await expect(page).toHaveURL(/\/tasks\/calendar$/);
  await page.keyboard.press('g');
  await page.keyboard.press('m');
  await expect(page).toHaveURL(/\/tasks\/my$/);

  // "?" opens the overlay, generated from the same registry.
  await page.keyboard.press('?');
  const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(help).toBeVisible();
  await expect(help).toContainText('Go to Upcoming');
  await expect(help).toContainText('New task');
  await page.keyboard.press('Escape');
  await expect(help).toHaveCount(0);

  // "N" creates a page and opens it.
  await page.keyboard.press('n');
  await expect(page).toHaveURL(/\/p\/[^/]+$/);
  await expect(page.locator('.ProseMirror')).toBeVisible();

  // Palette → theme switch command (preference starts at "system"; with a dark OS, the next step "light" is visible).
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+k');
  await palette.getByPlaceholder(/Search pages and tasks/).fill('dark mode');
  await expect(palette.locator('.palette-label', { hasText: 'Switch theme' })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('shortcuts are ignored while typing in an input', async ({ page, context, request }) => {
  const user = await createUser(request, 'Tia Typist');
  await signInContext(context, user);
  await page.goto(tasksUrl(user.wsId, 'all'));
  const filter = page.getByPlaceholder('Filter tasks…');
  await filter.click();
  await page.keyboard.type('gq?n');
  await expect(filter).toHaveValue('gq?n');
  await expect(page).toHaveURL(/\/tasks\/all$/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
