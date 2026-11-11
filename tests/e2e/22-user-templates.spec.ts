// User templates: "Save as template…" in the page menu, listed under the built-ins in the new-page picker,
// inserted through the editor with NEW tasks and COPIED attachments; rename and delete from the picker.
import { expect, test, type Page } from '@playwright/test';
import { api, createPage, createUser, eventually, focusEnd, listTasks, openPage, signInContext, taskRef } from './helpers.ts';

async function slash(page: Page, query: string) {
  await page.keyboard.type('/' + query);
  await expect(page.locator('.slash-menu')).toBeVisible();
}

test('save a page with a task and an attachment as a template, make new pages from it, rename and delete', async ({ page, context, request }) => {
  const user = await createUser(request, 'Tess Template');
  const { pageId: srcId, sectionId } = await createPage(request, user, { page: 'Quarterly plan' });
  await signInContext(context, user);

  // ── Build the source page: text, an attachment and a task ──
  const editor = await openPage(page, user.wsId, srcId);
  await focusEnd(page);
  await page.keyboard.type('Quarterly plan intro');
  await page.keyboard.press('Enter');
  await slash(page, 'attach');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Enter')]);
  await chooser.setFiles({ name: 'plan.txt', mimeType: 'text/plain', buffer: Buffer.from('plan attachment bytes') });
  await expect(editor).toContainText('plan.txt');
  await page.getByRole('button', { name: 'Add a task to this page' }).click();
  await expect(page.locator('.task-ref-title:focus')).toBeVisible();
  await page.keyboard.type('Write the plan');
  await page.keyboard.press('Escape');
  let original!: { id: string };
  await eventually(
    async () => (await listTasks(request, user)).filter((t) => t.title === 'Write the plan'),
    (ts) => (original = ts[0]!) !== undefined && ts[0]!.pageId === srcId,
    'task created on the source page',
  );
  await api(request, 'PATCH', `/tasks/${original.id}`, user.token, { priority: 2 });
  const originalHref = await editor.locator('.file-card-name').getAttribute('href');
  expect(originalHref).toBeTruthy();

  // ── Save as template ──
  await page.getByRole('button', { name: 'Page options' }).click();
  await page.getByRole('menuitem', { name: 'Save as template…' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Everyone in this workspace will be able to see and use this template');
  await dialog.getByRole('textbox').fill('Quarterly kit');
  await dialog.getByRole('button', { name: 'Save template' }).click();
  await expect(page.getByText('Template saved for the workspace')).toBeVisible();
  const saved = await api<{ id: string; name: string; taskCount: number; fileCount: number }[]>(request, 'GET', `/workspaces/${user.wsId}/templates`, user.token);
  expect(saved.map((t) => [t.name, t.taskCount, t.fileCount])).toEqual([['Quarterly kit', 1, 1]]);

  // ── New page from the template ──
  const second = await api<{ id: string }>(request, 'POST', `/sections/${sectionId}/pages`, user.token, { title: '' });
  const editor2 = await openPage(page, user.wsId, second.id);
  const mine = page.getByTestId('user-templates');
  await expect(page.getByText('Start with a template, or just type')).toBeVisible();
  await expect(page.locator('.template-card', { hasText: 'Meeting notes' })).toBeVisible(); // built-ins stay first
  await expect(mine.locator('.template-card', { hasText: 'Quarterly kit' })).toBeVisible();
  await mine.locator('.template-card', { hasText: 'Quarterly kit' }).click();
  await expect(editor2).toContainText('Quarterly plan intro');
  await expect(editor2).toContainText('plan.txt');
  const copyTitle = editor2.locator('.task-ref-title[data-value="Write the plan"]');
  await expect(copyTitle).toBeVisible();
  await expect(page.locator('.template-picker')).toHaveCount(0);

  // A NEW task exists (different id, on the new page); the original is untouched.
  let copyId = '';
  await eventually(
    async () => (await listTasks(request, user)).filter((t) => t.title === 'Write the plan'),
    (ts) => ts.length === 2 && ts.some((t) => t.id !== original.id && t.pageId === second.id),
    'a second task on the new page',
  );
  const tasks = await listTasks(request, user);
  const copy = tasks.find((t) => t.id !== original.id && t.title === 'Write the plan')!;
  copyId = copy.id;
  expect(copyId).not.toBe(original.id);
  const orig = tasks.find((t) => t.id === original.id)!;
  expect(orig.pageId).toBe(srcId);
  expect(orig.status).toBe('open');
  const withPriority = await api<{ id: string; priority: number; assigneeId: string | null }[]>(request, 'GET', `/workspaces/${user.wsId}/tasks`, user.token);
  expect(withPriority.find((t) => t.id === copyId)).toMatchObject({ priority: 2, assigneeId: user.id });

  // Completing the copy leaves the original open.
  await taskRef(page, 'Write the plan').getByRole('checkbox', { name: 'Complete task' }).click();
  await eventually(
    async () => (await listTasks(request, user)).find((t) => t.id === copyId),
    (t) => t === undefined || t.status === 'done',
    'copy completed',
  );
  const after = (await listTasks(request, user)).filter((t) => t.title === 'Write the plan');
  expect(after.find((t) => t.id === original.id)?.status).toBe('open');

  // The attachment was copied: a different file id with the same bytes.
  const copyHref = await editor2.locator('.file-card-name').getAttribute('href');
  expect(copyHref).toBeTruthy();
  expect(copyHref).not.toBe(originalHref);
  expect(await (await page.request.get(copyHref!)).text()).toBe('plan attachment bytes');

  // ── Rename and delete from the picker (on another empty page) ──
  const third = await api<{ id: string }>(request, 'POST', `/sections/${sectionId}/pages`, user.token, { title: '' });
  await openPage(page, user.wsId, third.id);
  await page.getByRole('button', { name: 'Rename template Quarterly kit' }).click();
  await page.getByRole('dialog').getByRole('textbox').fill('Quarterly kit v2');
  await page.getByRole('dialog').getByRole('button', { name: 'Rename' }).click();
  await expect(mine.locator('.template-card', { hasText: 'Quarterly kit v2' })).toBeVisible();
  await page.getByRole('button', { name: 'Delete template Quarterly kit v2' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete template' }).click();
  await expect(page.getByTestId('user-templates')).toHaveCount(0);
  expect(await api<unknown[]>(request, 'GET', `/workspaces/${user.wsId}/templates`, user.token)).toEqual([]);

  // Pages made from it (and its copied attachment) are unaffected.
  await page.goto(`/w/${user.wsId}/p/${second.id}`);
  await expect(page.locator('.ProseMirror')).toContainText('Quarterly plan intro');
  expect((await page.request.get(copyHref!)).status()).toBe(200);
});
