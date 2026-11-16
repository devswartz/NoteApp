// A page's ink as SVG (vector paths from nv-ink's geometry, the same shapes as on screen), for
// print/PDF now and SVG export later (PLAN_INK I3). Pure string building: tests/inkEngine.test.ts.
import { TOOL, type InkEngine } from './engine.ts';
import { zCompare } from './strokes.ts';

export interface InkSvgOptions {
  /** Draw no wider than this (CSS px); smaller ink keeps its size (1 page px = 1 CSS px, as on screen). */
  maxWidth?: number;
  /** Margin around the ink (page px). */
  pad?: number;
}

const hex2 = (n: number) => n.toString(16).padStart(2, '0');
const fmt = (n: number) => String(Math.round(n * 100) / 100);

/**
 * The strokes as one <svg>: highlighters first (under), then pens, each in z order; colours as
 * stored. Null when no stroke can be drawn.
 */
export function inkSvg(engine: InkEngine, strokes: { id: string; data: Uint8Array }[], opts: InkSvgOptions = {}): string | null {
  const pad = opts.pad ?? 4;
  const items = strokes
    .map((s) => ({ ...s, info: engine.info(s.data) }))
    .filter((s): s is typeof s & { info: NonNullable<typeof s.info> } => !!s.info && s.info.count > 0 && engine.valid(s.data))
    .sort((a, b) => (a.info.tool === TOOL.highlighter ? 0 : 1) - (b.info.tool === TOOL.highlighter ? 0 : 1) || zCompare({ z: a.info.z, id: a.id }, { z: b.info.z, id: b.id }));
  if (!items.length) return null;
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const { info } of items) {
    x0 = Math.min(x0, info.bounds.minX);
    y0 = Math.min(y0, info.bounds.minY);
    x1 = Math.max(x1, info.bounds.maxX);
    y1 = Math.max(y1, info.bounds.maxY);
  }
  // The page's origin stays in view when the ink is near it, so ink keeps its place relative to the top left.
  x0 = Math.min(0, x0) - pad;
  y0 = Math.min(0, y0) - pad;
  const w = x1 + pad - x0;
  const h = y1 + pad - y0;
  const scale = opts.maxWidth && w > opts.maxWidth ? opts.maxWidth / w : 1;
  const paths = items.map(({ data, info }) => {
    const c = info.color;
    const alpha = (c & 255) / 255;
    const fill = `#${hex2((c >>> 24) & 255)}${hex2((c >>> 16) & 255)}${hex2((c >>> 8) & 255)}`;
    return `<path d="${engine.svg(data) ?? ''}" fill="${fill}"${alpha < 1 ? ` fill-opacity="${fmt(alpha)}"` : ''}/>`;
  });
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" class="ink-svg" viewBox="${fmt(x0)} ${fmt(y0)} ${fmt(w)} ${fmt(h)}" width="${fmt(w * scale)}" height="${fmt(h * scale)}" fill-rule="nonzero">` +
    paths.join('') +
    `</svg>`
  );
}
