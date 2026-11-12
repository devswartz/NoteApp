// Appearance: the Hybrid theme (dark app chrome, light note page) and the accent colour,
// both kept per device across a reload; the main views pass axe in Hybrid.
import { expect, test, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createPage, createUser, openPage, signInContext } from './helpers.ts';

const bg = (l: Locator) => l.evaluate((el) => getComputedStyle(el).backgroundColor);
/** Relative luminance (0 black … 1 white) of an rgb()/rgba() colour. */
const luminance = (css: string) => {
  const [r, g, b] = (css.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number).map((v) => v / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

async function expectHybrid(page: Page) {
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'hybrid');
  // The chrome is dark …
  expect(luminance(await bg(page.locator('.sidebar')))).toBeLessThan(0.05);
  expect(luminance(await bg(page.locator('.ribbon').first()))).toBeLessThan(0.05);
  // … and the page is light, with dark text.
  const scroller = page.locator('.page-scroll');
  expect(luminance(await bg(scroller))).toBeGreaterThan(0.9);
  expect(luminance(await page.locator('.page-title').evaluate((el) => getComputedStyle(el).color))).toBeLessThan(0.05);
}

test('Hybrid: dark chrome around a light page; an accent colour recolours primary buttons; both survive a reload', async ({ page, context, request }) => {
  const user = await createUser(request, 'Hy Brid');
  const { pageId } = await createPage(request, user, { notebook: 'Hybrid Notebook', page: 'Paper on a desk' });
  await signInContext(context, user);
  await page.goto(`/w/${user.wsId}/settings?s=appearance`);

  const theme = page.getByRole('radiogroup', { name: 'Theme' });
  await theme.getByRole('radio', { name: 'Hybrid' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'hybrid');

  // Accent: a radio group of named swatches; the preview tiles' button uses the accent.
  const accents = page.getByRole('radiogroup', { name: 'Accent colour' });
  await expect(accents.getByRole('radio')).toHaveCount(8);
  await expect(accents.getByRole('radio', { name: 'Blue' })).toBeChecked();
  const button = page.locator('.theme-preview .tp-btn').first();
  const before = await bg(button);
  await accents.getByRole('radio', { name: 'Teal' }).check();
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'teal');
  await expect.poll(() => bg(button)).not.toBe(before);

  // Primary buttons in the chrome take the accent's dark-palette fill.
  await openPage(page, user.wsId, pageId);
  await expectHybrid(page);
  const primary = await page.evaluate(() => {
    const b = document.createElement('button');
    b.className = 'btn btn-primary';
    document.body.append(b);
    const c = getComputedStyle(b).backgroundColor;
    b.remove();
    return c;
  });
  expect(primary).toBe('rgb(15, 118, 110)'); // teal's dark-palette fill (#0f766e) in the chrome

  // Both settings are applied before first paint after a reload.
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'teal');
  await expectHybrid(page);
  await page.goto(`/w/${user.wsId}/settings?s=appearance`);
  await expect(page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Hybrid' })).toBeChecked();
  await expect(page.getByRole('radiogroup', { name: 'Accent colour' }).getByRole('radio', { name: 'Teal' })).toBeChecked();

  // The user menu offers Hybrid too.
  await page.getByRole('button', { name: 'Account and settings' }).click();
  const toggle = page.getByRole('group', { name: 'Theme', exact: true });
  await expect(toggle.getByRole('button', { name: 'Hybrid' })).toHaveAttribute('aria-pressed', 'true');
  await toggle.getByRole('button', { name: 'Light' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('Hybrid: the page, Tasks and Calendar pass axe', async ({ page, context, request }) => {
  const user = await createUser(request, 'Axe Hybrid');
  const { pageId } = await createPage(request, user, { notebook: 'A11y Hybrid', page: 'Accessible paper' });
  await signInContext(context, user);
  await page.addInitScript(() => {
    localStorage.setItem('noteapp.theme', 'hybrid');
    localStorage.setItem('noteapp.accent', 'purple');
  });
  for (const path of [`/w/${user.wsId}/p/${pageId}`, `/w/${user.wsId}/tasks/today`, `/w/${user.wsId}/tasks/calendar`, `/w/${user.wsId}/settings?s=appearance`]) {
    await page.goto(path);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'hybrid');
    await expect(page.locator('.sidebar .panel-head').first()).toBeVisible();
    if (path.includes('/p/')) await expect(page.locator('.page-title')).toBeVisible();
    // As in 31-nav-rail: the rail and panels (avatar colours come from user data, checked elsewhere),
    // plus the view itself, which in Hybrid is the light page on the notes route.
    // The rail's account button is left out too: axe's label-content-name-mismatch flags its avatar
    // initials against the "Account and settings" name for some names (e.g. "AH"), in any theme.
    const results = await new AxeBuilder({ page }).include('.rail').include('.sidebar').include('.main').exclude('.avatar').exclude('.rail button[title="Account and settings"]').analyze();
    const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), path).toEqual([]);
  }
});
