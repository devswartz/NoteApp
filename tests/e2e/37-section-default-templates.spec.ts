// Section default templates: "Default template…" in a section's menu, new pages there start filled
// (with a toast offering "Start blank"), subsections inherit, "New page from template", {date} and
// {time} placeholders, and a blank page's template prompt in view at 1200×830 without scrolling.
// With SCREENS=1 it also saves the screenshots in docs/screens/templates-*.png.
import { expect, test, type Page } from '@playwright/test';
import { api, createPage, createUser, eventually, firstEditor, openPage, signInContext, type TestUser } from './helpers.ts';

const shots = !!process.env.SCREENS;
const shot = async (page: Page, name: string) => {
  if (!shots) return;
  await page.waitForTimeout(400); // let menus finish fading in
  await page.screenshot({ path: `docs/screens/templates-${name}.png` });
};
const doc = (...content: unknown[]) => ({ type: 'doc', content });
const para = (t: string) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });
type TreeData = { sections: { id: string; name: string; parentId: string | null; defaultTemplateId?: string | null }[]; pages: { id: string; sectionId: string; title: string }[] };

// The browser runs in en-US / UTC (playwright.config.ts).
const longDate = () => new Date().toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

async function saveTemplate(request: Parameters<typeof api>[0], user: TestUser, pageId: string, name: string, ...lines: string[]) {
  return api<{ id: string }>(request, 'POST', `/pages/${pageId}/templates`, user.token, { name, content: doc(...lines.map(para)) });
}

test('a section default fills new pages, Start blank empties them, subsections inherit, New page from template', async ({ page, context, request }) => {
  await page.setViewportSize({ width: 1200, height: 830 });
  const user = await createUser(request, 'Dee Default');
  const { pageId: srcId, sectionId: general, notebookId } = await createPage(request, user, { notebook: 'Meetings', page: 'Source' });
  const standup = await saveTemplate(request, user, srcId, 'Standup {date}', 'Standup for {date} at {time}', 'Yesterday / today / blockers');
  await saveTemplate(request, user, srcId, 'Retro', 'What went well', 'What to change');
  await signInContext(context, user);
  const tree = () => api<TreeData>(request, 'GET', `/workspaces/${user.wsId}/tree`, user.token);

  await openPage(page, user.wsId, srcId);
  const sidebarTree = page.getByRole('navigation', { name: 'Sidebar' }).getByRole('tree', { name: 'Sections' });
  const generalRow = page.locator(`[data-node="${general}"]`).first();

  // ── Default template… in the section's menu ──
  await sidebarTree.getByText('General', { exact: true }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Default template…' })).toBeVisible();
  await shot(page, 'section-menu');
  await page.getByRole('menuitem', { name: 'Default template…' }).click();
  await expect(page.getByRole('menuitem', { name: 'None' })).toBeVisible();
  await shot(page, 'default-picker');
  await page.getByRole('menuitem', { name: 'Standup {date}' }).click();
  await eventually(tree, (t) => t.sections.find((s) => s.id === general)?.defaultTemplateId === standup.id, 'default saved');
  const badge = generalRow.getByTestId('section-default-template');
  await expect(badge).toBeVisible();
  await expect(badge).toHaveAttribute('title', 'New pages start from “Standup {date}”');

  // ── New page in that section: filled, with the toast ──
  await sidebarTree.getByText('General', { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New page', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/p/(?!${srcId})`));
  const editor = firstEditor(page);
  await expect(editor).toContainText(`Standup for ${longDate()} at `); // {date} and {time} filled in
  await expect(editor).not.toContainText('{time}');
  await expect(editor).toContainText('Yesterday / today / blockers');
  await expect(page.locator('.page-title')).toHaveValue(`Standup ${longDate()}`);
  const toast = page.locator('.toast', { hasText: 'Started from Standup {date}' });
  await expect(toast).toBeVisible();
  const newId = page.url().split('/p/')[1]!;
  await shot(page, 'filled-page');

  // ── Start blank takes it back to an empty page ──
  await toast.getByRole('button', { name: 'Start blank' }).click();
  await expect(page.getByText('Start with a template, or just type')).toBeVisible();
  await expect(page.locator('.canvas-wrap.is-blank')).toBeVisible();
  await expect(page.locator('.page-title')).toHaveValue('');
  await eventually(tree, (t) => t.pages.find((p) => p.id === newId)?.title === '', 'title cleared on the server');
  // Reopening doesn't fill it again (applied once).
  await openPage(page, user.wsId, newId);
  await expect(page.getByText('Start with a template, or just type')).toBeVisible();
  await expect(page.locator('.toast', { hasText: 'Started from' })).toHaveCount(0);

  // ── A subsection inherits; New page from the Notes overview ──
  const sub = await api<{ id: string }>(request, 'POST', `/notebooks/${notebookId}/sections`, user.token, { name: 'Weekly', parentId: general });
  const subRow = page.locator(`[data-node="${sub.id}"]`).first();
  await expect(subRow).toBeVisible();
  await expect(subRow.getByTestId('section-default-template')).toHaveAttribute('title', 'New pages start from “Standup {date}” (set on General)');
  await page.goto(`/w/${user.wsId}/notes?sec=${sub.id}`);
  await page.locator('.empty-section').getByRole('button', { name: 'New page' }).click();
  await expect(firstEditor(page)).toContainText(`Standup for ${longDate()}`);
  await eventually(tree, (t) => t.pages.some((p) => p.sectionId === sub.id), 'page made in the subsection');

  // ── New page from template ▸ in the section's menu ──
  await sidebarTree.getByText('General', { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New page from template' }).click();
  const fromMenu = page.getByRole('menu', { name: 'New page from template' });
  await expect(fromMenu.getByRole('menuitem').nth(1)).toContainText('Standup {date}'); // the default first…
  await expect(fromMenu.getByRole('menuitem', { name: /Standup/ })).toContainText('Default'); // …marked
  await expect(fromMenu.getByRole('menuitem', { name: 'Blank page' })).toBeVisible();
  await shot(page, 'new-from-template-menu');
  await fromMenu.getByRole('menuitem', { name: 'Retro' }).click();
  await expect(firstEditor(page)).toContainText('What went well');
  await expect(page.locator('.toast', { hasText: 'Started from Retro' })).toBeVisible();
  // Undo takes the template's content back too (it is one undo step on the page).
  await page.locator('.page-sub').click();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.getByText('What went well')).toHaveCount(0);

  // ── …and on the ribbon's New page (Notes overview) ──
  await page.goto(`/w/${user.wsId}/notes?sec=${general}`);
  await page.getByRole('button', { name: 'New page from template' }).click();
  const ribbonMenu = page.getByRole('menu', { name: 'New page from template' });
  await expect(ribbonMenu.getByRole('menuitem', { name: 'Retro' })).toBeVisible();
  await shot(page, 'ribbon-dropdown');
  await ribbonMenu.getByRole('menuitem', { name: 'Blank page' }).click();
  await expect(page.getByText('Start with a template, or just type')).toBeVisible();
  await expect(page.locator('.toast', { hasText: 'Started from' })).toHaveCount(0);
});

test('a blank page shows the template prompt without scrolling at 1200×830', async ({ page, context, request }) => {
  await page.setViewportSize({ width: 1200, height: 830 });
  const user = await createUser(request, 'Lay Out');
  const { pageId } = await createPage(request, user, { notebook: 'Layout', page: '' });
  await signInContext(context, user);
  await openPage(page, user.wsId, pageId);
  const prompt = page.getByText('Start with a template, or just type');
  await expect(prompt).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('button', { name: 'Add a task to this page' })).toBeInViewport({ ratio: 1 });
  const scroll = await page.locator('.page-scroll').evaluate((el) => ({ h: el.scrollHeight, c: el.clientHeight, top: el.getBoundingClientRect().top }));
  expect(scroll.h).toBeLessThanOrEqual(scroll.c); // a new page doesn't scroll
  // "Add icon" sits below the breadcrumb bar, not under it.
  await page.locator('.page-article').hover();
  const icon = await page.locator('.page-icon-add').boundingBox();
  const bar = await page.locator('.page-topbar').boundingBox();
  expect(icon!.y).toBeGreaterThanOrEqual(bar!.y + bar!.height);
  await shot(page, 'new-page-layout');
});
