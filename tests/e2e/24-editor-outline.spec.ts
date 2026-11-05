// "On this page" outline and full-width pages. Owner: Editor & Notes (agent 2), coordinated with QA.
import { test, expect, type Page } from '@playwright/test';
import { createPage, createUser, focusEnd, openPage, signInContext } from './helpers.ts';

/** Paste n sections (a heading and long paragraphs each) at the end of the page in one go. */
async function writeSections(page: Page, n: number) {
  await focusEnd(page);
  await page.waitForTimeout(150);
  await page.evaluate((count) => {
    let html = '';
    for (let i = 1; i <= count; i++) {
      html += `<h2>Section ${i}</h2>`;
      for (let j = 0; j < 8; j++) html += `<p>${`Paragraph ${j} of section ${i}. `.repeat(6)}</p>`;
    }
    const dt = new DataTransfer();
    dt.setData('text/html', html);
    dt.setData('text/plain', 'sections');
    document.querySelector('.ProseMirror')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, n);
  await expect(page.locator('.ProseMirror h2', { hasText: `Section ${n}` })).toBeVisible();
}

test.describe('outline and full width', () => {
  test.use({ viewport: { width: 1800, height: 900 } });

  test('the outline lists headings, jumps to them, and tracks the section in view', async ({ page, context, request }) => {
    const user = await createUser(request, 'Out Line');
    const { pageId } = await createPage(request, user, { page: 'Long page' });
    await signInContext(context, user);
    const editor = await openPage(page, user.wsId, pageId);
    // Two headings: no outline yet (it appears at three).
    await focusEnd(page);
    await page.keyboard.type('## One', { delay: 20 });
    await page.keyboard.press('Enter');
    await page.keyboard.type('## Two', { delay: 20 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    await expect(page.getByRole('navigation', { name: 'On this page' })).toHaveCount(0);
    await writeSections(page, 4);

    const nav = page.getByRole('navigation', { name: 'On this page' });
    await expect(nav.getByRole('button')).toHaveText(['One', 'Two', 'Section 1', 'Section 2', 'Section 3', 'Section 4']);
    await nav.getByRole('button', { name: 'Section 3' }).click();
    const heading = editor.locator('h2', { hasText: 'Section 3' });
    await expect.poll(async () => Math.round((await heading.boundingBox())!.y)).toBeLessThan(120);
    await expect(nav.locator('.is-active')).toHaveText('Section 3');
    // The cursor lands in the heading, so you can start typing there.
    await page.keyboard.type('!');
    await expect(heading).toHaveText('!Section 3');
  });

  test('full width is a per-page setting that persists and hides the outline', async ({ page, context, request }) => {
    const user = await createUser(request, 'Full Width');
    const { pageId } = await createPage(request, user, { page: 'Wide' });
    await signInContext(context, user);
    await openPage(page, user.wsId, pageId);
    await writeSections(page, 3);
    const article = page.locator('.page-article');
    const narrow = (await article.boundingBox())!.width;
    await page.locator('.page-topbar').getByTitle('Page options').click();
    await page.getByRole('menuitem', { name: /Full width/ }).click();
    await expect(article).toHaveClass(/is-full/);
    expect((await article.boundingBox())!.width).toBeGreaterThan(narrow + 200);
    await expect(page.getByRole('navigation', { name: 'On this page' })).toHaveCount(0);
    await page.waitForTimeout(1500);
    await page.reload();
    await expect(page.locator('.page-article')).toHaveClass(/is-full/, { timeout: 15_000 });
  });
});

test('fast typing with Markdown shortcuts in the middle of a long page lands in the right place', async ({ page, context, request }) => {
  const user = await createUser(request, 'Long Typer');
  const { pageId } = await createPage(request, user, { page: 'Very long' });
  await signInContext(context, user);
  const editor = await openPage(page, user.wsId, pageId);
  // 30 sections × 9 blocks: well past the long-page threshold (150 top-level blocks).
  await writeSections(page, 30);
  await expect(editor).toHaveClass(/is-long/);
  // A short, single-line block (End goes to the end of the visual line, so avoid wrapped paragraphs).
  const anchor = editor.locator('h2', { hasText: /^Section 15$/ });
  await anchor.click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('## Inserted heading');
  await page.keyboard.press('Enter');
  await page.keyboard.type('- first item');
  await page.keyboard.press('Enter');
  await page.keyboard.type('second item');
  await expect(editor.locator('h2', { hasText: 'Inserted heading' })).toHaveText('Inserted heading');
  const list = editor.locator('h2:has-text("Inserted heading") + ul li');
  await expect(list).toHaveText(['first item', 'second item']);
  await expect(editor.locator('h2', { hasText: /^Section 15$/ })).toHaveCount(1);
  await expect(editor.locator('h2:has-text("Section 15") + h2')).toHaveText('Inserted heading');
});
