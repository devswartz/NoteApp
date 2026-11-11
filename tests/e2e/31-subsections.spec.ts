// Subsections and templates tied to sections: create a subsection from the section menu, a page in it,
// save a template offered only there, and see it first on that section's empty pages (not elsewhere).
import { expect, test } from '@playwright/test';
import { api, createPage, createUser, eventually, focusEnd, openPage, signInContext } from './helpers.ts';

type TreeData = { sections: { id: string; name: string; parentId: string | null }[]; pages: { id: string; sectionId: string; title: string }[] };

test('subsection, a page in it, and a template offered in that section', async ({ page, context, request }) => {
  const user = await createUser(request, 'Sue Section');
  const { pageId: srcId, sectionId: generalId } = await createPage(request, user, { notebook: 'Plans', page: 'Kickoff source' });
  await signInContext(context, user);
  const tree = () => api<TreeData>(request, 'GET', `/workspaces/${user.wsId}/tree`, user.token);

  await openPage(page, user.wsId, srcId);
  await focusEnd(page);
  await page.keyboard.type('Sprint goals go here');

  // ── New subsection from the section's menu ──
  const sidebarTree = page.getByRole('navigation', { name: 'Sidebar' }).getByRole('tree', { name: 'Notebooks' });
  await sidebarTree.getByText('General', { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New subsection' }).click();
  await page.getByRole('dialog').getByRole('textbox').fill('Sprints');
  await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
  await expect(sidebarTree.getByText('Sprints', { exact: true })).toBeVisible();
  let sprints!: { id: string; parentId: string | null };
  await eventually(tree, (t) => !!(sprints = t.sections.find((s) => s.name === 'Sprints')!), 'subsection created');
  expect(sprints.parentId).toBe(generalId);
  // It's drawn inside its parent.
  await expect(page.locator('.sec', { has: page.locator(`[data-node="${generalId}"]`) }).first().locator(`[data-node="${sprints.id}"]`)).toBeVisible();

  // ── A page in the subsection ──
  await sidebarTree.getByText('Sprints', { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New page' }).click();
  let inSprints!: { id: string };
  await eventually(tree, (t) => !!(inSprints = t.pages.find((p) => p.sectionId === sprints.id)!), 'page created in the subsection');

  // ── Save the source page as a template available only in Sprints ──
  await openPage(page, user.wsId, srcId);
  await page.getByRole('button', { name: 'Page options' }).click();
  await page.getByRole('menuitem', { name: 'Save as template…' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox').fill('Sprint kickoff');
  await expect(dialog.getByText('Every section. Tick sections to offer it only there.')).toBeVisible();
  await dialog.getByRole('checkbox', { name: 'Sprints' }).check();
  await dialog.getByRole('button', { name: 'Save template' }).click();
  await expect(page.getByText('Template saved for the workspace')).toBeVisible();
  const saved = await api<{ name: string; sections: { sectionId: string }[] }[]>(request, 'GET', `/workspaces/${user.wsId}/templates`, user.token);
  expect(saved.map((t) => [t.name, t.sections.map((s) => s.sectionId)])).toEqual([['Sprint kickoff', [sprints.id]]]);

  // ── Offered first on an empty page in Sprints ──
  const editor = await openPage(page, user.wsId, inSprints.id);
  await expect(page.getByText('Templates for this section')).toBeVisible();
  await expect(page.getByTestId('section-templates').locator('.template-card', { hasText: 'Sprint kickoff' })).toBeVisible();
  await expect(page.getByText('Other templates')).toBeVisible();
  await page.getByTestId('section-templates').locator('.template-card', { hasText: 'Sprint kickoff' }).click();
  await expect(editor).toContainText('Sprint goals go here');

  // ── Not offered in a section it isn't tied to ──
  const other = await api<{ id: string }>(request, 'POST', `/sections/${generalId}/pages`, user.token, { title: '' });
  await openPage(page, user.wsId, other.id);
  await expect(page.getByText('Start with a template, or just type')).toBeVisible();
  await expect(page.getByText('Templates for this section')).toHaveCount(0);
  await expect(page.locator('.template-card', { hasText: 'Sprint kickoff' })).toHaveCount(0);
});
