// Editor extras (#21): page icon, ⌘K link editing, attachment file cards.
import { expect, test } from '@playwright/test';
import { api, createPage, createUser, eventually, focusEnd, openPage, signInContext } from './helpers.ts';

test('page icon: pick one; it shows on the page and in the sidebar, and is saved', async ({ page, context, request }) => {
  const user = await createUser(request, 'Ike Icon');
  const { pageId } = await createPage(request, user, { page: 'Iconic page' });
  await signInContext(context, user);
  await openPage(page, user.wsId, pageId);
  await page.getByRole('button', { name: 'Add icon' }).click();
  const picker = page.locator('.icon-picker');
  await expect(picker).toBeVisible();
  const first = picker.locator('.emoji-btn').first();
  const emoji = (await first.textContent())!.trim();
  await first.click();
  await expect(page.locator('.page-icon')).toHaveText(emoji);
  await eventually(() => api<{ page: { icon: string | null } }>(request, 'GET', `/pages/${pageId}`, user.token), (r) => r.page.icon === emoji, 'icon saved');
  await expect(page.getByRole('navigation', { name: 'Sidebar' }).locator('.sb-row', { hasText: 'Iconic page' })).toContainText(emoji);
});

test('⌘/Ctrl+K without a selection opens the palette; on selected text it adds a link', async ({ page, context, request }) => {
  const user = await createUser(request, 'Lou Link');
  const { pageId } = await createPage(request, user);
  await signInContext(context, user);
  const editor = await openPage(page, user.wsId, pageId);
  await focusEnd(page);
  // Nothing selected → the command palette.
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByRole('dialog', { name: 'Search' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Search' })).toHaveCount(0);

  // Text selected → the link editor.
  await focusEnd(page);
  await page.keyboard.type('Read the handbook');
  await page.keyboard.press('Shift+Home');
  // The editor picks up a keyboard selection asynchronously; the bubble menu appearing means it has.
  await expect(page.locator('.bubble-menu')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  const input = page.getByPlaceholder('Paste or type a link…');
  await expect(input).toBeFocused();
  await input.fill('https://example.com/handbook');
  await input.press('Enter');
  await expect(editor.locator('a[href="https://example.com/handbook"]')).toHaveText('Read the handbook');
  // (No further typing: with the text still selected, an early keystroke would replace it.)

  await page.reload();
  await expect(page.locator('.ProseMirror a[href="https://example.com/handbook"]')).toHaveText('Read the handbook');
});

test('an attachment renders as a file card with name, size and a working download', async ({ page, context, request }) => {
  const user = await createUser(request, 'Fay File');
  const { pageId } = await createPage(request, user);
  await signInContext(context, user);
  const editor = await openPage(page, user.wsId, pageId);
  await focusEnd(page);
  await page.keyboard.type('/attach');
  await expect(page.locator('.slash-menu')).toBeVisible();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Enter')]);
  await chooser.setFiles({ name: 'budget.csv', mimeType: 'text/csv', buffer: Buffer.from('item,cost\nchairs,120\n') });
  const card = editor.locator('.file-card', { hasText: 'budget.csv' });
  await expect(card).toBeVisible();
  await expect(card.locator('.file-card-size')).toHaveText(/\d+ B/);
  const href = await card.getByTitle('Download').getAttribute('href');
  expect(href).toBeTruthy();
  const res = await page.request.get(href!);
  expect(res.status()).toBe(200);
  expect(await res.text()).toContain('chairs,120');

  await page.reload();
  await expect(page.locator('.ProseMirror .file-card', { hasText: 'budget.csv' })).toBeVisible();
});
