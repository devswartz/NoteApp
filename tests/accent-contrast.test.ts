// Guards the accent colours (Settings › Appearance › Accent colour) against WCAG AA in Light,
// Dark and Hybrid: the default (blue) is the base tokens in src/styles.css, the others are in
// src/styles/accents.css. Hybrid needs no sets of its own (dark chrome, light page), so every
// light set is checked on the light surfaces and Hybrid's off-white page, every dark set on the
// dark surfaces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ACCENTS, DEFAULT_ACCENT } from '../src/store/ui.ts';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const css = read('../src/styles.css');
const accentsCss = read('../src/styles/accents.css');

/** The rule whose selector list ends with `selector` (each selector list ends "<last line> {\n"). */
const block = (src: string, selector: string) => {
  const start = src.indexOf(`${selector} {\n`);
  assert.ok(start >= 0, `missing ${selector}`);
  return src.slice(start, src.indexOf('\n}', start));
};
const token = (b: string, name: string) => {
  const m = b.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  assert.ok(m, `missing --${name}`);
  return m![1].toLowerCase();
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
/** `fg` at `alpha` composited over `bg` (hover rows, and active rows tinted with the accent). */
const over = (fg: readonly number[], alpha: number, bg: string) =>
  '#' + rgb(bg).map((d, i) => Math.round(fg[i] * alpha + d * (1 - alpha)).toString(16).padStart(2, '0')).join('');

const LIGHT = block(css, ":where(:root[data-theme='hybrid']) :is(.page-scroll, .history-doc, .link-editor, .slash-menu, .mention-pop, .color-grid)");
const DARK = block(css, '.scheme-dark');
const PAPER = block(css, ":where(:root[data-theme='hybrid']) :is(.page-scroll, .history-doc)");
const PAGE_TINTS = ['yellow', 'green', 'blue', 'purple', 'pink', 'grey'];

const palettes = {
  light: {
    base: LIGHT,
    surfaces: [
      ...['bg', 'bg-subtle', 'bg-sidebar', 'bg-elevated'].map((n) => token(LIGHT, n)),
      ...['bg', 'bg-subtle'].map((n) => token(PAPER, n)), // Hybrid's page
      ...PAGE_TINTS.map((n) => token(LIGHT, `page-${n}`)),
    ],
    hover: [[15, 15, 30], 0.05] as const,
    active: 0.09, // --bg-active: the accent mixed into the surface
    inverse: token(LIGHT, 'bg-inverse'),
  },
  dark: {
    base: DARK,
    surfaces: [...['bg', 'bg-subtle', 'bg-sidebar', 'bg-elevated'].map((n) => token(DARK, n)), ...PAGE_TINTS.map((n) => token(DARK, `page-${n}`))],
    hover: [[255, 255, 255], 0.06] as const,
    active: 0.15,
    inverse: token(DARK, 'bg-inverse'),
  },
};

/** One accent's tokens in one palette: the base tokens, overridden by its accents.css rule. */
function accentSet(id: string, mode: 'light' | 'dark') {
  const base = palettes[mode].base;
  if (id === DEFAULT_ACCENT) return (n: string) => token(base, n);
  const own = block(accentsCss, mode === 'light' ? `:where(:root[data-theme='hybrid'][data-accent='${id}']) :is(.page-scroll, .history-doc, .link-editor, .slash-menu, .mention-pop, .color-grid)` : `[data-accent='${id}'] .scheme-dark`);
  return (n: string) => (own.includes(`--${n}:`) ? token(own, n) : token(base, n));
}

test('every accent in the picker has CSS, and nothing else does', () => {
  const inCss = [...accentsCss.matchAll(/:root\[data-accent='([a-z]+)'\],/g)].map((m) => m[1]);
  assert.deepEqual(inCss.sort(), ACCENTS.map((a) => a.id).filter((id) => id !== DEFAULT_ACCENT).sort());
});

for (const { id } of ACCENTS)
  for (const mode of ['light', 'dark'] as const) {
    test(`${id} (${mode}${mode === 'light' ? ', and Hybrid’s page' : ', and Hybrid’s chrome'}): accent variants reach WCAG AA`, () => {
      const t = accentSet(id, mode);
      const p = palettes[mode];
      const accent = t('accent');
      // As text (links, active nav labels, checked states) on every surface, plain, hovered and active.
      for (const s of p.surfaces)
        for (const bg of [s, over(p.hover[0], p.hover[1], s), over(rgb(accent), p.active, s)])
          assert.ok(ratio(accent, bg) >= 4.5, `--accent ${accent} on ${bg}: ${ratio(accent, bg).toFixed(2)}`);
      // Hover text colour on the plain surfaces.
      for (const s of p.surfaces) assert.ok(ratio(t('accent-hover'), s) >= 4.5, `--accent-hover on ${s}: ${ratio(t('accent-hover'), s).toFixed(2)}`);
      // Filled buttons and badges: text on the fill, at rest and hovered.
      for (const fill of ['accent-solid', 'accent-solid-hover'])
        assert.ok(ratio(t('text-on-accent'), t(fill)) >= 4.5, `--text-on-accent on --${fill} ${t(fill)}: ${ratio(t('text-on-accent'), t(fill)).toFixed(2)}`);
      // Toast actions on the inverse surface.
      assert.ok(ratio(t('accent-inverse'), p.inverse) >= 4.5, `--accent-inverse ${t('accent-inverse')} on ${p.inverse}: ${ratio(t('accent-inverse'), p.inverse).toFixed(2)}`);
      // The focus ring (non-text, 3:1) against the surfaces it surrounds.
      for (const s of p.surfaces) assert.ok(ratio(accent, s) >= 3, `focus ring on ${s}`);
    });
  }
