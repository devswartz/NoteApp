// The full-width ribbon (OneNote layout): placement above the rail and panels, collapse,
// disabled editing on non-page views, and the Page group (page colour, rule lines).
import { expect, test, type Browser } from '@playwright/test';
import { createPage, createTeam, createUser, focusEnd, openPage, signInContext, tasksUrl, type TestUser } from './helpers.ts';

async function userPage(browser: Browser, user: TestUser) {
  const context = await browser.newContext();
  await signInContext(context, user);
  return { context, page: await context.newPage() };
}

test('the ribbon spans the window above the rail, the panels and the note; one row at narrow widths', async ({ page, context, request }) => {
  const user = await createUser(request, 'Wren Wide');
  const { pageId } = await createPage(request, user);
  await signInContext(context, user);
  await page.setViewportSize({ width: 1400, height: 800 });
  await openPage(page, user.wsId, pageId);
  const ribbon = page.getByRole('toolbar', { name: 'Ribbon' });
  const r = (await ribbon.boundingBox())!;
  expect(r.x).toBe(0);
  expect(r.y).toBeLessThan(2);
  expect(r.width).toBeGreaterThan(1390);
  const bottom = r.y + r.height;
  for (const sel of ['.rail', '.sidebar', '.page-topbar']) {
    const b = (await page.locator(sel).first().boundingBox())!;
    expect(b.y, sel).toBeGreaterThanOrEqual(bottom - 1);
  }
  for (const name of ['Text', 'Lists', 'Insert', 'Page', 'View']) await expect(ribbon.getByRole('group', { name, exact: true })).toBeVisible();
  // Key buttons have text labels on wide windows.
  await expect(ribbon.getByRole('button', { name: 'Page colour' })).toContainText('Page colour');
  await expect(ribbon.getByRole('button', { name: 'Rule lines' })).toContainText('Rule lines');

  // Narrow desktop: still one row, no horizontal page scroll.
  for (const width of [1000, 800]) {
    await page.setViewportSize({ width, height: 800 });
    const h = (await ribbon.boundingBox())!.height;
    expect(h, `${width}px`).toBeLessThan(50);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(ribbon.getByRole('button', { name: /^Undo/ })).toBeInViewport();
  }
});

test('collapse shrinks the ribbon to a strip, remembered across a reload; a click restores it', async ({ page, context, request }) => {
  const user = await createUser(request, 'Cole Collapse');
  const { pageId } = await createPage(request, user);
  await signInContext(context, user);
  await openPage(page, user.wsId, pageId);
  const ribbon = page.getByRole('toolbar', { name: 'Ribbon' });
  const tall = (await ribbon.boundingBox())!.height;
  // Live as soon as the page opens, before anything is clicked.
  await expect(ribbon.getByRole('button', { name: /^Bold/ })).not.toHaveAttribute('aria-disabled', 'true');
  const collapse = ribbon.getByRole('button', { name: 'Collapse the ribbon' });
  expect((await collapse.boundingBox())!.height).toBeGreaterThanOrEqual(28);
  await collapse.click();
  await expect(ribbon.getByRole('button', { name: /^Bold/ })).toHaveCount(0);
  expect((await ribbon.boundingBox())!.height).toBeLessThan(tall / 2);
  await expect(ribbon.getByRole('button', { name: 'Show the ribbon' })).toContainText('Show ribbon');

  // Ctrl+F1 toggles it, as in Office.
  await page.keyboard.press('Control+F1');
  await expect(ribbon.getByRole('button', { name: /^Bold/ })).toBeVisible();
  await page.keyboard.press('Control+F1');
  await expect(ribbon.getByRole('button', { name: /^Bold/ })).toHaveCount(0);

  await page.reload();
  await expect(page.locator('.sync-live')).toBeVisible({ timeout: 15_000 });
  await expect(ribbon.getByRole('button', { name: 'Show the ribbon' })).toBeVisible();
  await expect(ribbon.getByRole('button', { name: /^Bold/ })).toHaveCount(0);

  await ribbon.getByRole('button', { name: 'Show the ribbon' }).click();
  await expect(ribbon.getByRole('button', { name: /^Bold/ })).toBeVisible();
  await page.reload();
  await expect(ribbon.getByRole('button', { name: /^Bold/ })).toBeVisible();
});

test('on the Tasks view the ribbon is a quiet strip, not a row of dead buttons; the Panels button works on a page', async ({ page, context, request }) => {
  const user = await createUser(request, 'Tad Tasks');
  const { pageId } = await createPage(request, user);
  await signInContext(context, user);
  await page.goto(tasksUrl(user.wsId, 'today'));
  const strip = page.locator('.ribbon.is-off');
  await expect(strip).toBeVisible();
  await expect(strip).toContainText('Open a note to use the ribbon');
  expect((await strip.boundingBox())!.height).toBeLessThan(40);
  await expect(page.getByRole('toolbar', { name: 'Ribbon' })).toHaveCount(0);
  await expect(page.locator('.ribbon button')).toHaveCount(0);

  await openPage(page, user.wsId, pageId);
  const panels = page.getByRole('toolbar', { name: 'Ribbon' }).getByRole('button', { name: 'Panels' });
  await expect(panels).toHaveAttribute('aria-pressed', 'true');
  await panels.click();
  await expect(page.locator('.sidebar')).toBeHidden();
  await expect(panels).toHaveAttribute('aria-pressed', 'false');
  await panels.click();
  await expect(page.locator('.sidebar')).toBeVisible();
});

test('OneNote shortcuts: Ctrl+1 checklist, Ctrl+. bullets, Ctrl+Alt+1/2/3 headings; tooltips show them', async ({ page, context, request }) => {
  const user = await createUser(request, 'Ona Keys');
  const { pageId } = await createPage(request, user);
  await signInContext(context, user);
  const editor = await openPage(page, user.wsId, pageId);
  const ribbon = page.getByRole('toolbar', { name: 'Ribbon' });
  await expect(ribbon.getByRole('button', { name: /^Checklist/ })).toHaveAttribute('title', /\+1\)$/);
  await expect(ribbon.getByRole('button', { name: /^Bulleted list/ })).toHaveAttribute('title', /\+\.\)$/);

  await focusEnd(page);
  await page.keyboard.press('Enter');
  await page.keyboard.type('To do');
  await page.keyboard.press('ControlOrMeta+1');
  await expect(editor.locator('ul[data-type="taskList"] li', { hasText: 'To do' })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+1');
  await page.keyboard.press('ControlOrMeta+.');
  await expect(editor.locator('ul:not([data-type]) li', { hasText: 'To do' })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+.');
  await page.keyboard.press('ControlOrMeta+Alt+2');
  await expect(editor.locator('h2', { hasText: 'To do' })).toBeVisible();
});

test('page colour and rule lines apply, sync to a second person, and persist', async ({ browser, request }) => {
  const alice = await createUser(request, 'Ada Colour');
  const bob = await createUser(request, 'Ben Lines');
  const teamId = await createTeam(request, alice, [{ user: bob, role: 'viewer' }]);
  const { pageId } = await createPage(request, alice, { wsId: teamId, page: 'Tinted' });
  const a = await userPage(browser, alice);
  const b = await userPage(browser, bob);
  await openPage(a.page, teamId, pageId);
  await b.page.goto(`/w/${teamId}/p/${pageId}`);
  await expect(b.page.getByTestId('canvas-surface')).toBeVisible();

  const ribbon = a.page.getByRole('toolbar', { name: 'Ribbon' });
  await ribbon.getByRole('button', { name: 'Page colour' }).click();
  await ribbon.getByRole('button', { name: 'Page colour: Green' }).click();
  await ribbon.getByRole('button', { name: 'Rule lines' }).click();
  await ribbon.getByRole('button', { name: 'Rule lines: Lines' }).click();

  const scroller = (p: typeof a.page) => p.locator('.page-scroll');
  await expect(scroller(a.page)).toHaveAttribute('data-page-color', 'green');
  await expect(scroller(a.page)).toHaveAttribute('data-rules', 'lines');
  const tint = await a.page.evaluate(() => getComputedStyle(document.querySelector('.page-scroll')!).backgroundColor);
  const plain = await a.page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
  expect(tint).not.toBe('rgba(0, 0, 0, 0)');
  expect(tint).not.toBe(plain);
  // Lines run across the whole page width, behind the boxes.
  const rules = a.page.locator('.page-rules');
  expect(await rules.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain('repeating-linear-gradient');
  expect((await rules.boundingBox())!.width).toBeGreaterThanOrEqual((await scroller(a.page).boundingBox())!.width - 20);

  // The viewer sees them live, read-only (the Page group is disabled for viewers).
  await expect(scroller(b.page)).toHaveAttribute('data-page-color', 'green');
  await expect(scroller(b.page)).toHaveAttribute('data-rules', 'lines');
  await expect(b.page.getByRole('toolbar', { name: 'Ribbon' }).getByRole('button', { name: 'Page colour' })).toHaveAttribute('aria-disabled', 'true');

  // Grid, then a reload: saved with the page.
  await ribbon.getByRole('button', { name: 'Rule lines' }).click();
  await ribbon.getByRole('button', { name: 'Rule lines: Grid' }).click();
  await expect(scroller(b.page)).toHaveAttribute('data-rules', 'grid');
  await a.page.waitForTimeout(800);
  await a.page.reload();
  await expect(a.page.locator('.sync-live')).toBeVisible({ timeout: 15_000 });
  await expect(scroller(a.page)).toHaveAttribute('data-page-color', 'green');
  await expect(scroller(a.page)).toHaveAttribute('data-rules', 'grid');

  await a.context.close();
  await b.context.close();
});
