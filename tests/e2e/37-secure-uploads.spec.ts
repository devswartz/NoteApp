// Uploads are served only through signed links (shared/fileLinks.ts): an image inserted into a
// note still renders, after a reload, and in print; the bare upload address is refused, and an
// old unsigned link opened in a tab is signed by the app for whoever is signed in.
import { test, expect, type Page } from '@playwright/test';
import { createPage, createUser, focusEnd, openPage, signInContext } from './helpers.ts';

// A 2×2 red PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DAwMDAxMDAAAAX/gH+7ff6xwAAAABJRU5ErkJggg==',
  'base64',
);

/** Waits for the image to have loaded real pixels (a refused one has naturalWidth 0). */
async function loaded(page: Page, selector: string) {
  await expect
    .poll(() => page.locator(selector).first().evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0), { timeout: 10_000 })
    .toBe(true);
}

test('an uploaded image renders in the note, after a reload, and in print; the bare address is refused', async ({ page, context, request }) => {
  const user = await createUser(request, 'Secure Img');
  const { pageId } = await createPage(request, user, { page: 'Photos' });
  await signInContext(context, user);
  await page.addInitScript(() => {
    window.print = () => {};
  });
  const editor = await openPage(page, user.wsId, pageId);
  await focusEnd(page);
  await page.keyboard.type('/image');
  await expect(page.locator('.slash-menu .slash-item').first()).toBeVisible();
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Enter')]);
  await fc.setFiles({ name: 'red.png', mimeType: 'image/png', buffer: PNG });

  const img = editor.locator('img').first();
  await expect(img).toBeVisible();
  const src = (await img.getAttribute('src'))!;
  expect(src).toMatch(/\/uploads\/[0-9a-f]{32}\.png\?u=[\w-]+&e=\d+&s=[0-9a-f]{32}$/);
  await loaded(page, '.ProseMirror img');

  // The signed link works; the same address without its signature does not.
  const plain = src.replace(/\?.*$/, '');
  expect((await page.request.get(src)).status()).toBe(200);
  expect((await page.request.get(plain)).status()).toBe(401);

  // After a reload the stored (unsigned) path is signed again.
  await page.waitForTimeout(1500); // the collab server saves 1 s after the last edit
  await page.reload();
  await expect(page.locator('.sync-live')).toBeVisible({ timeout: 15_000 });
  await loaded(page, '.ProseMirror img');

  // Print: the page laid out for paper still shows the image.
  await page.locator('.ProseMirror').first().click();
  await page.keyboard.press('ControlOrMeta+p');
  await page.emulateMedia({ media: 'print' });
  const root = page.locator('#print-root');
  await expect(root).toBeVisible();
  await expect(root.locator('img')).toHaveCount(1);
  await loaded(page, '#print-root img');
  await page.emulateMedia({ media: 'screen' });

  // An old unsigned link opened in a tab goes through the app, which signs it for this user.
  // (On the web the service worker may answer from this device's copy instead; either way the image shows.)
  const tab = await context.newPage();
  await tab.goto(plain);
  await expect(tab.locator('img')).toBeVisible();
  await loaded(tab, 'img');
  await tab.close();

  // Someone else, signed in elsewhere: the app signs the old link as them, and the server refuses it.
  const other = await createUser(request, 'Other Person');
  const otherCtx = await page.context().browser()!.newContext({ serviceWorkers: 'block' });
  await signInContext(otherCtx, other);
  const otherPage = await otherCtx.newPage();
  await otherPage.goto(new URL(plain, page.url()).href);
  await expect(otherPage).toHaveURL(new RegExp(`/uploads/.*\\?u=${other.id}&.*s=[0-9a-f]{32}$`));
  expect((await otherPage.request.get(otherPage.url())).status()).toBe(403);
  await otherCtx.close();
});

test('Settings → Profile → Export my data downloads a zip', async ({ page, context, request }) => {
  const user = await createUser(request, 'Export Me');
  await createPage(request, user, { page: 'My exported page' });
  await signInContext(context, user);
  await page.goto(`/w/${user.wsId}/settings?s=profile`);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export my data' }).click()]);
  expect(download.suggestedFilename()).toMatch(/data \d{4}-\d{2}-\d{2}\.zip$/);
});
