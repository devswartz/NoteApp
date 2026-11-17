// Ink on canvas pages (docs/PLAN_INK.md, phase I1), behind the `ink` flag (localStorage
// noteapp.flags.ink = 1): draw a stroke with the pen tool, see it on a second client (which has
// the flag off: it shows ink but offers no pen tools), print it as vector paths, undo and redo it,
// and erase it. The mouse draws when a pen tool is picked; pen-specific input (pressure, tilt,
// coalesced and predicted events, Windows delegated ink) needs a real pen and isn't covered here.
import { expect, test, type Page } from '@playwright/test';
import { createPage, createUser, pageUrl, signInContext } from './helpers.ts';

const surface = (page: Page) => page.getByTestId('canvas-surface');

/** How many pixels of a layer canvas have ink on them. */
const inkPixels = (page: Page, layer: 'ink-over' | 'ink-under' = 'ink-over') =>
  page.getByTestId(layer).evaluate((c: HTMLCanvasElement) => {
    if (!c.width || !c.height) return 0;
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i]! > 0) n++;
    return n;
  });

/** Drag the mouse across the surface from one point to another (surface coordinates). */
async function draw(page: Page, from: [number, number], to: [number, number]) {
  const s = (await surface(page).boundingBox())!;
  await page.mouse.move(s.x + from[0], s.y + from[1]);
  await page.mouse.down();
  await page.mouse.move(s.x + (from[0] + to[0]) / 2, s.y + (from[1] + to[1]) / 2 + 30, { steps: 10 });
  await page.mouse.move(s.x + to[0], s.y + to[1], { steps: 10 });
  await page.mouse.up();
}

test('ink: draw with the pen, another client sees it, it prints as vector paths, undo/redo, erase', async ({ browser, request }) => {
  const user = await createUser(request, 'Ivy Ink');
  const { pageId } = await createPage(request, user, { notebook: 'Sketches', page: 'Ink page' });

  const a = await browser.newContext();
  await signInContext(a, user);
  await a.addInitScript(() => {
    localStorage.setItem('noteapp.flags.ink', '1');
    (window as unknown as { __printed: number }).__printed = 0;
    window.print = () => {
      (window as unknown as { __printed: number }).__printed++;
    };
  });
  const pa = await a.newPage();
  const b = await browser.newContext();
  await signInContext(b, user);
  const pb = await b.newPage();
  for (const p of [pa, pb]) {
    await p.goto(pageUrl(user.wsId, pageId));
    await expect(surface(p)).toBeVisible();
    await expect(p.locator('.sync-live')).toBeAttached({ timeout: 15_000 });
  }

  // The flag shows the pen toolbar; without it there's none.
  const tools = pa.getByTestId('ink-toolbar');
  await expect(tools).toBeVisible();
  await expect(pb.getByTestId('ink-toolbar')).toHaveCount(0);

  // Draw a stroke with the pen (the mouse draws while a pen tool is picked).
  await tools.getByRole('button', { name: 'Pen', exact: true }).click();
  await tools.getByRole('button', { name: 'Blue' }).click();
  await expect(surface(pa)).toHaveClass(/ink-active/);
  const boxesBefore = await pa.locator('.canvas-box:not(.is-ready)').count();
  await draw(pa, [420, 380], [640, 420]);
  await expect.poll(() => inkPixels(pa), { timeout: 10_000 }).toBeGreaterThan(200);
  // Drawing didn't start a text box.
  await expect(pa.locator('.canvas-box:not(.is-ready)')).toHaveCount(boxesBefore);

  // The other client draws it too (it loads the ink engine for a page with ink).
  await expect.poll(() => inkPixels(pb), { timeout: 10_000 }).toBeGreaterThan(200);
  const seen = await inkPixels(pb);

  // Print: the stroke is a vector path in the printed page, in its colour.
  await pa.keyboard.press('ControlOrMeta+p');
  await expect.poll(() => pa.evaluate(() => (window as unknown as { __printed: number }).__printed)).toBe(1);
  const printedInk = pa.locator('#print-root .print-ink svg path');
  await expect(printedInk).toHaveCount(1);
  await expect(printedInk).toHaveAttribute('fill', '#1d4ed8');
  expect((await printedInk.getAttribute('d'))!.length).toBeGreaterThan(50);
  await pa.evaluate(() => window.dispatchEvent(new Event('afterprint')));

  // Undo takes the stroke away on both clients; redo brings it back.
  await tools.getByRole('button', { name: 'Pen', exact: true }).focus();
  await pa.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => inkPixels(pa)).toBe(0);
  await expect.poll(() => inkPixels(pb)).toBe(0);
  await pa.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(() => inkPixels(pa)).toBeGreaterThan(200);
  await expect.poll(() => inkPixels(pb)).toBe(seen);

  // A highlighter stroke goes under the text (its own layer).
  await tools.getByRole('button', { name: 'Highlighter' }).click();
  await draw(pa, [420, 520], [640, 520]);
  await expect.poll(() => inkPixels(pa, 'ink-under')).toBeGreaterThan(200);
  await expect.poll(() => inkPixels(pb, 'ink-under')).toBeGreaterThan(200);

  // The stroke eraser removes what it touches, everywhere.
  await tools.getByRole('button', { name: 'Eraser (whole strokes)' }).click();
  await draw(pa, [530, 300], [530, 600]);
  await expect.poll(() => inkPixels(pa)).toBe(0);
  await expect.poll(() => inkPixels(pa, 'ink-under')).toBe(0);
  await expect.poll(() => inkPixels(pb)).toBe(0);

  // Back to select: clicking the page starts a text box again.
  await tools.getByRole('button', { name: 'Select and type' }).click();
  await expect(surface(pa)).not.toHaveClass(/ink-active/);

  await a.close();
  await b.close();
});
