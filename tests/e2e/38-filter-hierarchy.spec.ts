// The Team and Section filter menus show their hierarchy: subteams under their team, notebooks as captions
// over nested sections. Ticking a parent covers what is under it, and the covered rows say so.
// Set E2E_SHOTS=<dir> to also save screenshots.
import { expect, test, type Page } from '@playwright/test';
import { api, createPage, createTask, createUser, ribbon, signInContext, taskRow, tasksUrl } from './helpers.ts';

const shot = async (page: Page, name: string) => {
  if (process.env.E2E_SHOTS) await page.waitForTimeout(300); // let the checkbox transitions finish
  if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/${name}.png` });
};

const row = (page: Page, label: string) => page.locator('.fp-opt').filter({ has: page.locator('.menu-label', { hasText: new RegExp(`^${label}$`) }) });

test('teams and sections are listed as a hierarchy, and a ticked parent covers what is under it', async ({ page, context, request }) => {
  const owner = await createUser(request, 'Olive Owner');
  const ws = owner.wsId;
  const post = <T>(path: string, body: unknown) => api<T>(request, 'POST', path, owner.token, body);
  const elders = await post<{ id: string }>(`/workspaces/${ws}/teams`, { name: 'Elders', memberIds: [owner.id] });
  const shepherds = await post<{ id: string }>(`/workspaces/${ws}/teams`, { name: 'Shepherds', parentId: elders.id, memberIds: [owner.id] });
  await post(`/workspaces/${ws}/teams`, { name: 'Deacons', parentId: elders.id, memberIds: [owner.id] });
  const staff = await post<{ id: string }>(`/workspaces/${ws}/teams`, { name: 'Staff', memberIds: [owner.id] });
  await post(`/workspaces/${ws}/teams`, { name: 'Worship', parentId: staff.id, memberIds: [owner.id] });
  await createTask(request, owner, ws, { title: 'Elders job', teamId: elders.id });
  await createTask(request, owner, ws, { title: 'Shepherd job', teamId: shepherds.id });
  await createTask(request, owner, ws, { title: 'Staff job', teamId: staff.id });

  const { notebookId, sectionId } = await createPage(request, owner, { notebook: 'Handbook', page: 'Intro' });
  const appendix = await post<{ id: string }>(`/notebooks/${notebookId}/sections`, { name: 'Appendix', parentId: sectionId });
  const deep = await post<{ id: string }>(`/notebooks/${notebookId}/sections`, { name: 'Forms', parentId: appendix.id });
  const other = await post<{ id: string }>(`/notebooks/${notebookId}/sections`, { name: 'Archive' });
  const formsPage = await post<{ id: string }>(`/sections/${deep.id}/pages`, { title: 'Form A' });
  const archivePage = await post<{ id: string }>(`/sections/${other.id}/pages`, { title: 'Old stuff' });
  await createTask(request, owner, ws, { title: 'Form task', pageId: formsPage.id });
  await createTask(request, owner, ws, { title: 'Archive task', pageId: archivePage.id });

  await signInContext(context, owner);
  await page.goto(tasksUrl(ws, 'all'));
  const bar = ribbon(page);

  // Teams: Shepherds sits under Elders, indented; the member count is on the right.
  await bar.getByRole('button', { name: /^Team filter/ }).click();
  await expect(row(page, 'Elders')).not.toHaveClass(/fp-nested/);
  await expect(row(page, 'Shepherds')).toHaveClass(/fp-nested/);
  await expect(row(page, 'Worship')).toHaveClass(/fp-nested/);
  await shot(page, 'teams-hierarchy');
  await row(page, 'Elders').click();
  await expect(row(page, 'Shepherds').locator('.fp-box')).toHaveClass(/is-covered/);
  await expect(row(page, 'Worship').locator('.fp-box')).not.toHaveClass(/is-covered/);
  await shot(page, 'teams-covered');
  // Without subteams, nothing is covered any more.
  await page.getByRole('menuitemcheckbox', { name: 'Include subteams' }).click();
  await expect(row(page, 'Shepherds').locator('.fp-box')).not.toHaveClass(/is-covered/);
  await page.getByRole('menuitemcheckbox', { name: 'Include subteams' }).click();
  // Searching lists matches flat with their full name.
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await row(page, 'Staff').click();
  await page.keyboard.press('Escape');
  await expect(taskRow(page, 'Staff job')).toBeVisible();
  await expect(taskRow(page, 'Elders job')).toHaveCount(0);
  await bar.getByRole('button', { name: /^Team filter/ }).click();
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await row(page, 'Elders').click();
  await page.keyboard.press('Escape');
  await expect(taskRow(page, 'Shepherd job')).toBeVisible();
  await expect(taskRow(page, 'Staff job')).toHaveCount(0);

  // Sections: the notebook is a caption, subsections nest under their section.
  await bar.getByRole('button', { name: 'Clear filters' }).click();
  await bar.getByRole('button', { name: 'More filters' }).click();
  await page.getByRole('menuitem', { name: 'Section', exact: true }).click();
  await expect(page.locator('.fp-head', { hasText: 'Handbook' })).toBeVisible();
  await expect(row(page, 'Appendix')).toHaveClass(/fp-nested/);
  await expect(row(page, 'Forms')).toHaveClass(/fp-nested/);
  await shot(page, 'sections-hierarchy');
  await row(page, 'Appendix').click();
  await expect(row(page, 'Forms').locator('.fp-box')).toHaveClass(/is-covered/);
  await expect(row(page, 'Archive').locator('.fp-box')).not.toHaveClass(/is-covered/);
  await shot(page, 'sections-covered');
  await page.keyboard.press('Escape');
  await expect(taskRow(page, 'Form task')).toBeVisible();
  await expect(taskRow(page, 'Archive task')).toHaveCount(0);
});
