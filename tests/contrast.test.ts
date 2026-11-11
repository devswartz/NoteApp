// Guards the colour tokens in src/styles.css against WCAG AA (4.5:1 for small text).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const block = (selector: string) => {
  const start = css.indexOf(`${selector} {`);
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
  ['light', ':root', [[15, 15, 30, 0.05], [79, 70, 229, 0.09]]],
  ['dark', ":root[data-theme='dark']", [[255, 255, 255, 0.06], [129, 140, 248, 0.16]]],
] as const) {
  test(`${theme}: text tokens reach 4.5:1 on every surface`, () => {
    const b = block(sel);
    const surfaces = ['bg', 'bg-subtle', 'bg-sidebar', 'bg-elevated'].map((n) => token(b, n));
    const all = [...surfaces, ...surfaces.flatMap((s) => overlays.map((o) => over(o as unknown as [number, number, number, number], s)))];
    for (const name of ['text', 'text-2', 'text-muted']) {
      const c = token(b, name);
      for (const s of all) assert.ok(ratio(c, s) >= 4.5, `--${name} ${c} on ${s}: ${ratio(c, s).toFixed(2)}`);
    }
    // Placeholders sit in inputs, which use --bg.
    assert.ok(ratio(token(b, 'text-placeholder'), token(b, 'bg')) >= 4.5, 'placeholder on --bg');
  });
}

// Editor text and highlight colours (src/styles/colors.css; names in shared/colors.ts).
const { COLOR_NAMES } = await import('../shared/colors.ts');
const colorsCss = readFileSync(new URL('../src/styles/colors.css', import.meta.url), 'utf8');
const colorBlock = (selector: string) => {
  const start = colorsCss.indexOf(`${selector} {`);
  assert.ok(start >= 0, `colors.css: missing ${selector}`);
  return colorsCss.slice(start, colorsCss.indexOf('\n}', start));
};
for (const [theme, sel] of [
  ['light', ':root'],
  ['dark', ":root[data-theme='dark']"],
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
