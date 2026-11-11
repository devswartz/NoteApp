// How a canvas page goes onto paper (pure; tests/printLayout.test.ts). A canvas places boxes
// anywhere on a wide surface; paper is narrow and paginated, so printing uses a flow layout:
// boxes in reading order, grouped into rows. Boxes beside each other on the canvas (their
// vertical ranges overlap and they don't overlap sideways) print side by side, as columns
// sized in proportion to their canvas widths, when every column still gets a readable width
// on paper; otherwise they are stacked one under the other. Wide boxes print alone at the
// full printable width. Text reflows at the printed width, so nothing is clipped.
import { readingOrder, type BoxGeom } from '../../shared/pageDoc.ts';

export interface PrintBox extends Pick<BoxGeom, 'id' | 'x' | 'y' | 'w'> {
  wide?: boolean;
  /** Height on the canvas (measured on the open page; estimated elsewhere). */
  h: number;
}

/** One printed row: its boxes left to right, and the share of the printable width each gets (sums to 1). */
export interface PrintRow {
  ids: string[];
  widths: number[];
}

/** A column narrower than this (CSS px on paper) is too cramped: the row is stacked instead. */
export const MIN_COLUMN_PX = 200;
/** Gap between printed columns (CSS px). */
export const COLUMN_GAP_PX = 24;

const overlapsX = (a: PrintBox, b: PrintBox) => a.x < b.x + b.w && b.x < a.x + a.w;

/**
 * Group boxes into printed rows for paper `paperWidth` CSS px wide (about 680 for A4 with
 * 15–20 mm margins). Rows come in reading order; inside a row, boxes go left to right.
 */
export function printRows(boxes: PrintBox[], paperWidth: number): PrintRow[] {
  const groups: PrintBox[][] = [];
  let cur: PrintBox[] = [];
  let bottom = -Infinity;
  for (const b of readingOrder(boxes)) {
    const joins = cur.length > 0 && !b.wide && !cur[0].wide && b.y < bottom && cur.every((o) => !overlapsX(o, b));
    if (joins) {
      cur.push(b);
      bottom = Math.max(bottom, b.y + b.h);
    } else {
      if (cur.length) groups.push(cur);
      cur = [b];
      bottom = b.y + b.h;
    }
  }
  if (cur.length) groups.push(cur);

  const rows: PrintRow[] = [];
  for (const g of groups) {
    const cols = [...g].sort((a, b) => a.x - b.x || a.y - b.y);
    if (cols.length === 1) {
      rows.push({ ids: [cols[0].id], widths: [1] });
      continue;
    }
    const total = cols.reduce((s, b) => s + Math.max(1, b.w), 0);
    const usable = paperWidth - COLUMN_GAP_PX * (cols.length - 1);
    const widths = cols.map((b) => Math.max(1, b.w) / total);
    if (widths.every((f) => f * usable >= MIN_COLUMN_PX)) rows.push({ ids: cols.map((b) => b.id), widths });
    // Too many or too narrow to sit side by side on paper: one under the other, in reading order.
    else for (const b of readingOrder(g)) rows.push({ ids: [b.id], widths: [1] });
  }
  return rows;
}

/** Rough canvas height of a box from its blocks, for when it can't be measured (pages that aren't open). */
export function estimateBoxHeight(blocks: { type?: string; content?: unknown[] }[]): number {
  let h = 16;
  for (const n of blocks) {
    const kids = Array.isArray(n.content) ? n.content.length : 0;
    if (n.type === 'image') h += 240;
    else if (n.type === 'table') h += 36 * Math.max(1, kids);
    else if (/List$/.test(n.type ?? '')) h += 28 * Math.max(1, kids);
    else if (n.type === 'codeBlock') h += 120;
    else h += 30;
  }
  return h;
}
