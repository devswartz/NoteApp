// Picked lines (Ctrl/Cmd+click inside a box): the pure part. A "line" is a textblock (paragraph, heading,
// a list item's or task item's text, a table cell's paragraph) or an atom block (an inline task). No DOM or
// editor here, so tests/linePicks.test.ts runs it in node. The extension that tracks and draws them is
// ./linePicks.ts; "Print selection" prints them (src/print).
import type { JSONContent } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import type { Mapping } from '@tiptap/pm/transform';
import { selectionBlocks } from '../print/selectionContent.ts';

/** A picked line: the range of its node in the document (from = before it, to = after it). */
export interface LinePick {
  from: number;
  to: number;
  /** An atom block (a task), not a textblock. */
  node: boolean;
}

export const samePick = (a: LinePick, b: LinePick) => a.from === b.from && a.to === b.to;

const isLine = (n: PMNode) => n.isTextblock || (n.isBlock && n.isAtom);

/** The line at a document position: the textblock around it (null between blocks or in an empty doc). */
export function lineAt(doc: PMNode, pos: number): LinePick | null {
  const $p = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  for (let d = $p.depth; d > 0; d--) {
    const n = $p.node(d);
    if (n.isTextblock) return { from: $p.before(d), to: $p.after(d), node: false };
  }
  const after = $p.nodeAfter;
  if (after && after.isBlock && after.isAtom) return { from: pos, to: pos + after.nodeSize, node: true };
  return null;
}

/** Every line that touches the span between two positions (either order), in document order. */
export function linesBetween(doc: PMNode, a: number, b: number): LinePick[] {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const out: LinePick[] = [];
  doc.descendants((n, pos) => {
    if (pos > hi) return false;
    if (!isLine(n)) return true;
    if (pos + n.nodeSize >= lo) out.push({ from: pos, to: pos + n.nodeSize, node: !n.isTextblock });
    return false;
  });
  return out;
}

/** Picks after taking `line` out (if it was picked) or adding it. */
export function toggleLine(picks: readonly LinePick[], line: LinePick): LinePick[] {
  return picks.some((p) => samePick(p, line)) ? picks.filter((p) => !samePick(p, line)) : [...picks, line];
}

export const addLines = (picks: readonly LinePick[], lines: readonly LinePick[]): LinePick[] => [...picks, ...lines.filter((l) => !picks.some((p) => samePick(p, l)))];
export const removeLines = (picks: readonly LinePick[], lines: readonly LinePick[]): LinePick[] => picks.filter((p) => !lines.some((l) => samePick(p, l)));

/** Is `pick` still a whole line of `doc`? */
export function validPick(doc: PMNode, pick: LinePick): boolean {
  if (pick.from < 0 || pick.to > doc.content.size || pick.from >= pick.to) return false;
  const n = doc.nodeAt(pick.from);
  return !!n && isLine(n) && pick.from + n.nodeSize === pick.to;
}

/** The picks after a change to the document: each moves with its text; one whose line is gone is dropped. */
export function mapPicks(picks: readonly LinePick[], mapping: Mapping, doc: PMNode): LinePick[] {
  const out: LinePick[] = [];
  for (const p of picks) {
    const from = mapping.map(p.from, 1);
    const to = mapping.map(p.to, -1);
    const next = { from, to, node: p.node };
    if (validPick(doc, next) && !out.some((o) => samePick(o, next))) out.push(next);
  }
  return out;
}

const inOrder = (picks: readonly LinePick[]) => [...picks].sort((a, b) => a.from - b.from);

/** What a picked line prints as: its blocks, with the list or table around it and list numbers kept. */
function lineBlocks(doc: PMNode, pick: LinePick): JSONContent[] {
  if (pick.node) return selectionBlocks(NodeSelection.create(doc, pick.from));
  // The text inside the textblock; an empty line has nothing to print.
  return selectionBlocks(TextSelection.create(doc, pick.from + 1, pick.to - 1));
}

/** The picked lines as blocks, in document order. */
export function pickBlocks(doc: PMNode, picks: readonly LinePick[]): JSONContent[] {
  return inOrder(picks)
    .filter((p) => validPick(doc, p))
    .flatMap((p) => lineBlocks(doc, p));
}

/** The picked lines as plain text, one per line, in document order. */
export function pickText(doc: PMNode, picks: readonly LinePick[]): string {
  return inOrder(picks)
    .filter((p) => validPick(doc, p))
    .map((p) => doc.textBetween(p.from, p.to, ' ', ' '))
    .filter((t) => t.trim())
    .join('\n');
}
