// Where a page's content lives in its Y.Doc (see docs/PLAN_CANVAS.md).
//   Document pages: one fragment, `default`.
//   Canvas pages:   `boxes` (Y.Map: box id → Y.Map { x, y, w, z }) and one fragment per box,
//                   `box:<id>`. `default` stays empty.
// Anything that reads a page's text, tasks, mentions or links goes through
// pageFragments() so it sees every box, in reading order.
import * as Y from 'yjs';

export const DEFAULT_FIELD = 'default';
export const BOXES_KEY = 'boxes';
export const BOX_PREFIX = 'box:';

export interface BoxGeom {
  id: string;
  x: number;
  y: number;
  /** Width in page pixels; the height follows the content. */
  w: number;
  /** Stacking order: higher is in front. */
  z: number;
}

export const boxField = (id: string) => BOX_PREFIX + id;
/** Is this root type name page content (as opposed to metadata such as `boxes`)? */
export const isContentField = (name: string) => name === DEFAULT_FIELD || name.startsWith(BOX_PREFIX);

const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** The boxes of a canvas page with their geometry (unknown or broken values defaulted). */
export function boxGeoms(doc: Y.Doc): BoxGeom[] {
  const out: BoxGeom[] = [];
  doc.getMap<unknown>(BOXES_KEY).forEach((v, id) => {
    const get = (k: string) => (v instanceof Y.Map ? v.get(k) : v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined);
    out.push({ id, x: num(get('x'), 0), y: num(get('y'), 0), w: num(get('w'), 400), z: num(get('z'), 0) });
  });
  return out;
}

/** Reading order: top to bottom, then left to right (the id breaks exact ties, so the order is stable). */
export function readingOrder<T extends Pick<BoxGeom, 'id' | 'x' | 'y'>>(boxes: T[]): T[] {
  return [...boxes].sort((a, b) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Every content fragment of a page in reading order: `default` first, then the boxes. */
export function pageFragments(doc: Y.Doc): Y.XmlFragment[] {
  return [doc.getXmlFragment(DEFAULT_FIELD), ...readingOrder(boxGeoms(doc)).map((b) => doc.getXmlFragment(boxField(b.id)))];
}

/**
 * Like observeDeep on every content fragment, including boxes added later: `fn` gets the
 * deep events of each content root that changed in a transaction.
 */
export function observePageContent(doc: Y.Doc, fn: (events: Y.YEvent<Y.AbstractType<unknown>>[], tr: Y.Transaction) => void): () => void {
  const handler = (tr: Y.Transaction) => {
    const events: Y.YEvent<Y.AbstractType<unknown>>[] = [];
    for (const [name, type] of doc.share) {
      if (!isContentField(name)) continue;
      const evs = tr.changedParentTypes.get(type as Y.AbstractType<Y.YEvent<Y.AbstractType<unknown>>>);
      if (evs) events.push(...(evs as Y.YEvent<Y.AbstractType<unknown>>[]));
    }
    if (events.length) fn(events, tr);
  };
  doc.on('afterTransaction', handler);
  return () => doc.off('afterTransaction', handler);
}
