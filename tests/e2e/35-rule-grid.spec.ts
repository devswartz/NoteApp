// Rule lines on: every line of text sits on a rule line (ruled paper), whatever block it is in,
// and text after a table is back on the grid (src/editor/ruleGrid.ts, canvas.css .has-rules).
import { test, expect, type Page } from '@playwright/test';
import { addInlineTask, createPage, createUser, focusEnd, openPage, signInContext } from './helpers.ts';

async function slash(page: Page, query: string) {
  await page.keyboard.type('/' + query);
  await expect(page.locator('.slash-menu .slash-item').first()).toBeVisible();
  await page.keyboard.press('Enter');
}

const LONG ='A long task title that wraps onto a second line '.repeat(6).trim();

/** Each text line's vertical centre, offset (px) from the middle between two rule lines, keyed by a label. */
async function offsets(page: Page) {
  return page.evaluate(() => {
    const rules = document.querySelector<HTMLElement>('.page-rules')!;
    const unit = parseFloat(getComputedStyle(rules).getPropertyValue('--rule'));
    const inset = parseFloat(getComputedStyle(rules).getPropertyValue('--rule-inset'));
    // Lines are the last pixel of each unit, the pattern shifted down by the box inset; text
    // should be centred between two lines, i.e. half a unit past a line.
    const middleAt = rules.getBoundingClientRect().top + inset + unit - 0.5 + unit / 2;
    const off = (y: number) => {
      const d = (((y - middleAt) % unit) + unit) % unit;
      return d > unit / 2 ? d - unit : d;
    };
    const out: { label: string; off: number }[] = [];
    const root = document.querySelector('.canvas-box .ProseMirror')!;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const parent = n.parentElement!;
      if (!n.textContent!.trim() || parent.closest('[contenteditable="false"]')) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const seen = new Set<number>();
      for (const r of range.getClientRects()) {
        if (seen.has(Math.round(r.bottom))) continue;
        seen.add(Math.round(r.bottom));
        out.push({ label: `${parent.closest('p, h1, h2, h3, li, td, th')?.tagName}:${n.textContent!.slice(0, 20)}`, off: off(r.top + r.height / 2) });
      }
    }
    for (const ta of root.querySelectorAll<HTMLTextAreaElement>('.task-ref-title')) {
      const cs = getComputedStyle(ta);
      const lh = parseFloat(cs.lineHeight);
      const top = ta.getBoundingClientRect().top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop);
      const lines = Math.round((ta.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)) / lh);
      for (let k = 0; k < lines; k++) out.push({ label: `task line ${k + 1}/${lines}`, off: off(top + k * lh + lh / 2) });
    }
    return out;
  });
}

test('rule lines: text in every block sits centred between the lines', async ({ page, context, request }) => {
  const user = await createUser(request, 'Rhea Rules');
  const { pageId } = await createPage(request, user);
  await signInContext(context, user);
  await openPage(page, user.wsId, pageId);

  await focusEnd(page);
  await page.keyboard.type('Intro paragraph');
  await addInlineTask(page, LONG); // leaves the caret on an empty line under the task
  await page.keyboard.type('## Section heading');
  await page.keyboard.press('Enter');
  await slash(page, 'checklist');
  await page.keyboard.type('Checklist item');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter'); // leave the checklist: an empty line
  await page.keyboard.press('Enter');
  await page.keyboard.type('After the table');
  await page.keyboard.press('ArrowUp');
  await slash(page, 'table');
  await page.keyboard.type('Cell');

  const ribbon = page.getByRole('toolbar', { name: 'Ribbon' });
  await ribbon.getByRole('button', { name: 'Rule lines' }).click();
  await ribbon.getByRole('button', { name: 'Rule lines: Lines' }).click();
  await expect(page.locator('.page-scroll.has-rules')).toBeVisible();
  await page.mouse.click(5, 5); // nothing focused: no opaque box, no toolbar
  await expect(page.locator(`.task-ref-title[data-value="${LONG}"]`)).toHaveCount(1);

  let found: { label: string; off: number }[] = [];
  await expect(async () => {
    found = await offsets(page);
    const bad = found.filter((o) => Math.abs(o.off) > 2);
    expect(bad, JSON.stringify(found)).toEqual([]);
  }).toPass({ timeout: 7_000 });
  const labels = found.map((o) => o.label).join('|');
  for (const want of ['Intro paragraph', 'Section heading', 'Checklist item', 'Cell', 'After the table', 'task line 2/']) expect(labels).toContain(want);
  // The heading takes whole units, and the text after the table is back on the grid.
  expect(Math.abs(found.find((o) => o.label.includes('After the table'))!.off)).toBeLessThanOrEqual(2);

  // Rules off again: the margins added for the grid go away.
  await ribbon.getByRole('button', { name: 'Rule lines' }).click();
  await ribbon.getByRole('button', { name: 'Rule lines: None' }).click();
  await expect(page.locator('.page-scroll.has-rules')).toHaveCount(0);
  await expect(page.locator('.canvas-box .ProseMirror > [style*="margin-bottom"]')).toHaveCount(0);
});
