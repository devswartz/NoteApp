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
