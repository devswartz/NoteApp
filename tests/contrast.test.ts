// Guards the colour tokens in src/styles.css against WCAG AA (4.5:1 for small text).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
// The light and dark token blocks each list several selectors; this is the last line of each.
const LIGHT = ":where(:root[data-theme='hybrid']) :is(.page-scroll, .history-doc, .link-editor, .slash-menu, .mention-pop, .color-grid)";
const DARK = '.scheme-dark';
const block = (selector: string) => {
  const start = css.indexOf(`${selector} {
`);
  assert.ok(start >= 0, `missing ${selector}`);
  return css.slice(start, css.indexOf('\n}', start));
};
const token = (b: string, name: string) => {
  const m = b.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  assert.ok(m, `missing --${name}`);
  return m![1];
};
const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lum = (h: string) => {
  const [r, g, b] = rgb(h).map((v) => v / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
/** A translucent overlay (hover/active) composited over a surface. */
const over = (fg: [number, number, number, number], bg: string) =>
  '#' + rgb(bg).map((d, i) => Math.round(fg[i] * fg[3] + d * (1 - fg[3])).toString(16).padStart(2, '0')).join('');

for (const [theme, sel, overlays] of [
  ['light', LIGHT, [[15, 15, 30, 0.05], [79, 70, 229, 0.09]]],
  ['dark', DARK, [[255, 255, 255, 0.06], [139, 149, 249, 0.15]]],
] as const) {
  test(`${theme}: text tokens reach 4.5:1 on every surface`, () => {
    const b = block(sel);
    const surfaces = ['bg', 'bg-subtle', 'bg-sidebar', 'bg-elevated'].map((n) => token(b, n));
    // Hybrid's note page: the light tokens on a slightly off-white page.
    if (theme === 'light') surfaces.push(...['bg', 'bg-subtle'].map((n) => token(block(":where(:root[data-theme='hybrid']) :is(.page-scroll, .history-doc)"), n)));
    const all = [...surfaces, ...surfaces.flatMap((s) => overlays.map((o) => over(o as unknown as [number, number, number, number], s)))];
    for (const name of ['text', 'text-2', 'text-muted']) {
      const c = token(b, name);
      for (const s of all) assert.ok(ratio(c, s) >= 4.5, `--${name} ${c} on ${s}: ${ratio(c, s).toFixed(2)}`);
    }
    // Placeholders sit in inputs, which use --bg.
    assert.ok(ratio(token(b, 'text-placeholder'), token(b, 'bg')) >= 4.5, 'placeholder on --bg');
  });
}

// Page colours (ribbon › Page colour; names in shared/pageDoc.ts): the page's text, and the
// hover/active rows on it, stay readable on every tint.
for (const [theme, sel, overlays] of [
  ['light', LIGHT, [[15, 15, 30, 0.05], [79, 70, 229, 0.09]]],
  ['dark', DARK, [[255, 255, 255, 0.06], [139, 149, 249, 0.15]]],
] as const) {
  test(`${theme}: text tokens reach 4.5:1 on every page colour`, async () => {
    const { PAGE_COLORS } = await import('../shared/pageDoc.ts');
    const b = block(sel);
    for (const name of PAGE_COLORS.filter((c) => c !== 'none')) {
      const tint = token(b, `page-${name}`);
      const all = [tint, ...overlays.map((o) => over(o as unknown as [number, number, number, number], tint))];
      // A tinted page shows muted text and placeholders in --page-text-muted (src/styles/canvas.css).
      for (const t of ['text', 'text-2', 'page-text-muted', 'accent'])
        for (const s of all) assert.ok(ratio(token(b, t), s) >= 4.5, `--${t} on --page-${name} ${s}: ${ratio(token(b, t), s).toFixed(2)}`);
    }
  });
}

// Editor text and highlight colours (src/styles/colors.css; names in shared/colors.ts).
const { COLOR_NAMES } = await import('../shared/colors.ts');
const colorsCss = readFileSync(new URL('../src/styles/colors.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const colorBlock = (selector: string) => {
  const start = colorsCss.indexOf(`${selector} {
`);
  assert.ok(start >= 0, `colors.css: missing ${selector}`);
  return colorsCss.slice(start, colorsCss.indexOf('\n}', start));
};
for (const [theme, sel] of [
  ['light', LIGHT],
  ['dark', DARK],
] as const) {
  test(`${theme}: editor text colours reach 4.5:1 on the page; text reaches 4.5:1 on every highlight`, () => {
    const b = block(sel);
    const c = colorBlock(sel);
    const surfaces = ['bg', 'bg-subtle', 'bg-elevated'].map((n) => token(b, n));
    for (const name of COLOR_NAMES) {
      const fg = token(c, `tc-${name}`);
      for (const s of surfaces) assert.ok(ratio(fg, s) >= 4.5, `--tc-${name} ${fg} on ${s}: ${ratio(fg, s).toFixed(2)}`);
      const hl = token(c, `hl-${name}`);
      for (const t of ['text', 'text-2']) assert.ok(ratio(token(b, t), hl) >= 4.5, `--${t} on --hl-${name} ${hl}: ${ratio(token(b, t), hl).toFixed(2)}`);
    }
  });
}

test('avatar initials always reach 4.5:1 against the user colour', async () => {
  const { initialsColor } = await import('../src/components/ui.tsx');
  const lum = (hex: string) => {
    const lin = (i: number) => {
      const c = parseInt(hex.slice(1 + i, 3 + i), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4);
  };
  const ratio = (a: string, b: string) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  for (let r = 0; r < 256; r += 17)
    for (let g = 0; g < 256; g += 17)
      for (let b = 0; b < 256; b += 17) {
        const bg = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
        assert.ok(ratio(bg, initialsColor(bg)) >= 4.5, bg);
      }
});
