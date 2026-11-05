// Priority 6: editor blocks (Markdown shortcuts, slash menu, table, image upload, attachment) and search.
import { expect, test, type Page } from '@playwright/test';
import { createPage, createTask, createUser, eventually, api, focusEnd, openPage, signInContext } from './helpers.ts';

// 1×1 transparent PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

async function slash(page: Page, query: string) {
  await page.keyboard.type('/' + query);
  const menu = page.locator('.slash-menu');
  await expect(menu).toBeVisible();
  return menu;
}

test.describe('editor', () => {
  test('Markdown shortcuts create headings, lists, quotes, code and dividers; they persist', async ({ page, context, request }) => {
    const user = await createUser(request, 'Mark Down');
    const { pageId } = await createPage(request, user);
    await signInContext(context, user);
    const editor = await openPage(page, user.wsId, pageId);
    await focusEnd(page);

    const k = page.keyboard;
    await k.type('# Big heading');
    await k.press('Enter');
    await k.type('## Smaller heading');
    await k.press('Enter');
    await k.type('- bullet one');
    await k.press('Enter');
    await k.type('bullet two');
    await k.press('Enter');
    await k.press('Enter'); // leave the list
    await k.type('1. first');
    await k.press('Enter');
    await k.press('Enter');
    await k.type('> quoted words');
    await k.press('Enter');
    await k.press('Enter');
    await k.type('```');
    await k.press('Enter');
    await k.type('const x = 1;');
    await expect(editor.locator('pre code')).toContainText('const x = 1;');

    await expect(editor.locator('h1')).toHaveText('Big heading');
    await expect(editor.locator('h2')).toHaveText('Smaller heading');
    await expect(editor.locator('ul > li')).toHaveCount(2);
    await expect(editor.locator('ol > li')).toHaveText('first');
    await expect(editor.locator('blockquote')).toContainText('quoted words');

    await page.reload();
    await expect(editor.locator('h1')).toHaveText('Big heading');
    await expect(editor.locator('ul > li')).toHaveCount(2);
    await expect(editor.locator('pre code')).toContainText('const x = 1;');
  });

  test('slash menu filters and inserts blocks (table, divider, task); Escape cancels', async ({ page, context, request }) => {
    const user = await createUser(request, 'Sly Slash');
    const { pageId } = await createPage(request, user);
    await signInContext(context, user);
    const editor = await openPage(page, user.wsId, pageId);
    await focusEnd(page);

    const menu = await slash(page, 'tab');
    await expect(menu.locator('.slash-item')).toHaveCount(1);
    await expect(menu.locator('.slash-title')).toHaveText('Table');
    await page.keyboard.press('Enter');
    await expect(menu).toHaveCount(0);
    await expect(editor.locator('table')).toBeVisible();
    await page.keyboard.type('cell A1');
    await page.keyboard.press('Tab');
    await page.keyboard.type('cell B1');
    await expect(editor.locator('table td, table th').filter({ hasText: 'cell B1' })).toBeVisible();

    // Escape closes the menu without inserting anything.
    await focusEnd(page);
    await page.keyboard.press('Enter');
    await slash(page, 'div');
    await page.keyboard.press('Escape');
    await expect(page.locator('.slash-menu')).toHaveCount(0);
    await expect(editor.locator('hr')).toHaveCount(0);
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');

    await page.keyboard.press('Enter');
    await slash(page, 'divider');
    await page.keyboard.press('Enter');
    await expect(editor.locator('hr')).toHaveCount(1);

    await focusEnd(page);
    await page.keyboard.press('Enter');
    await slash(page, 'task');
    await page.keyboard.press('Enter');
    await expect(page.locator('.task-ref-title:focus')).toBeVisible();
    await page.keyboard.type('Task from slash');
    await page.keyboard.press('Escape');
    await eventually(() => api<{ title: string; pageId: string | null }[]>(request, 'GET', `/workspaces/${user.wsId}/tasks`, user.token), (ts) => ts.some((t) => t.title === 'Task from slash' && t.pageId === pageId), 'slash task saved and linked');
  });

  test('image upload and file attachment via the slash menu', async ({ page, context, request }) => {
    const user = await createUser(request, 'Ivy Image');
    const { pageId } = await createPage(request, user);
    await signInContext(context, user);
    const editor = await openPage(page, user.wsId, pageId);
    await focusEnd(page);

    await slash(page, 'image');
    const [imgChooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Enter')]);
    await imgChooser.setFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: PNG });
    const img = editor.locator('img');
    await expect(img).toBeVisible();
    const src = await img.getAttribute('src');
    expect(src).toBeTruthy();
    // The uploaded image is served back. (Uses the browser context so any auth the app adds applies.)
    const res = await page.request.get(src!);
    expect(res.status()).toBe(200);

    await focusEnd(page);
    await page.keyboard.press('Enter');
    await slash(page, 'attach');
    const [fileChooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Enter')]);
    await fileChooser.setFiles({ name: 'minutes.txt', mimeType: 'text/plain', buffer: Buffer.from('meeting minutes') });
    await expect(editor).toContainText('minutes.txt');

    await page.reload();
    await expect(editor.locator('img')).toBeVisible();
    await expect(editor).toContainText('minutes.txt');
  });

  test('bubble menu formats selected text', async ({ page, context, request }) => {
    const user = await createUser(request, 'Bea Bold');
    const { pageId } = await createPage(request, user);
    await signInContext(context, user);
    const editor = await openPage(page, user.wsId, pageId);
    await focusEnd(page);
    await page.keyboard.press('Enter');
    await page.keyboard.type('make me bold');
    await page.keyboard.press('Shift+Home');
    await page.locator('.bubble-menu').getByRole('button', { name: /Bold/ }).click();
    await expect(editor.locator('strong')).toHaveText('make me bold');
  });
});

test.describe('search', () => {
  test('⌘K finds pages by body text and tasks by title, and opens them', async ({ page, context, request }) => {
    const user = await createUser(request, 'Sergio Search');
    const { pageId } = await createPage(request, user, { page: 'Zeppelin logistics' });
    await createTask(request, user, user.wsId, { title: 'Refuel the quokka balloon' });
    await signInContext(context, user);

    // Body text is indexed when the collab server saves the page.
    await openPage(page, user.wsId, pageId);
    await focusEnd(page);
    await page.keyboard.type('helium supplier xylophonic');
    await eventually(
      () => api<{ pages: unknown[] }>(request, 'GET', `/workspaces/${user.wsId}/search?q=xylophonic`, user.token),
      (r) => JSON.stringify(r).includes(pageId),
      'page body indexed',
    );

    await page.goto(`/w/${user.wsId}/tasks/today`);
    await expect(page.getByRole('heading', { name: 'Today', level: 1 })).toBeVisible();
    await page.keyboard.press('ControlOrMeta+k');
    const palette = page.getByRole('dialog', { name: 'Search' });
    const input = palette.getByPlaceholder(/Search pages and tasks/);
    await input.fill('xylophonic');
    await expect(palette.locator('.palette-label', { hasText: 'Zeppelin logistics' })).toBeVisible();
    await input.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/p/${pageId}`));

    await page.keyboard.press('ControlOrMeta+k');
    await input.fill('quokka');
    await expect(palette.locator('.palette-label', { hasText: 'Refuel the quokka balloon' })).toBeVisible();
    await input.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Task details' })).toBeVisible();

    // Page titles match too.
    await page.keyboard.press('Escape');
    await page.keyboard.press('ControlOrMeta+k');
    await input.fill('Zeppelin');
    await expect(palette.locator('.palette-label', { hasText: 'Zeppelin logistics' })).toBeVisible();
  });

  test('search never returns another user’s private content', async ({ page, context, request }) => {
    const alice = await createUser(request, 'Alice Hidden');
    const bob = await createUser(request, 'Bob Seeker');
    const teamId = await api<{ id: string }>(request, 'POST', '/workspaces', alice.token, { name: 'Search Team' }).then((r) => r.id);
    await api(request, 'POST', `/workspaces/${teamId}/members`, alice.token, { email: bob.email, role: 'member' });
    const priv = await createPage(request, alice, { wsId: teamId, page: 'Confidential flamingo', visibility: 'private' });
    await createTask(request, alice, teamId, { title: 'Secret flamingo task', pageId: priv.pageId });

    const r = await api(request, 'GET', `/workspaces/${teamId}/search?q=flamingo`, bob.token);
    expect(JSON.stringify(r)).not.toContain('flamingo');

    await signInContext(context, bob);
    await page.goto(`/w/${teamId}/tasks/today`);
    await expect(page.getByRole('heading', { name: 'Today', level: 1 })).toBeVisible();
    await page.keyboard.press('ControlOrMeta+k');
    await page.getByPlaceholder(/Search pages and tasks/).fill('flamingo');
    await expect(page.locator('.palette-list')).toContainText('Create task'); // results have rendered
    await expect(page.locator('.palette-list')).not.toContainText('Confidential');
    await expect(page.locator('.palette-list')).not.toContainText('Secret flamingo');
  });
});
