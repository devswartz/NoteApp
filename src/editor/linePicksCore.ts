// Picked text (Word-style multi-selection): the pure part. The first selection is the browser's own; holding
// Ctrl/Cmd while making the next one keeps the earlier ones as "picks": exact character ranges in a box's document,
// highlighted like a selection. No DOM or editor here, so tests/linePicks.test.ts runs it in node. The extension that
// tracks and draws them is ./linePicks.ts; "Print selection" and Copy use them (src/print, PrintSelectionMenu.tsx).
import type { JSONContent } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Selection, TextSelection } from '@tiptap/pm/state';
import { Mapping, ReplaceStep, StepMap, type Transform } from '@tiptap/pm/transform';
import { selectionBlocks } from '../print/selectionContent.ts';

/** A picked range of a box's document (positions as the editor counts them). */
export interface RangePick {
  from: number;
  to: number;
}

export const sameRange = (a: RangePick, b: RangePick) => a.from === b.from && a.to === b.to;

/**
 * A selection as a pick, or null when nothing visible is in it. A triple-click selects up to the start of the next
 * paragraph (and a drag can start at the very end of a line): those ends step back onto the text they belong to.
 */
export function rangeOf(doc: PMNode, from: number, to: number): RangePick | null {
  const size = doc.content.size;
  let a = Math.max(0, Math.min(from, to, size));
  let b = Math.min(size, Math.max(from, to));
  if (b <= a) return null;
  const $b = doc.resolve(b);
  if ($b.parentOffset === 0) {
    const before = Selection.findFrom($b, -1, true);
    if (before && before.to > a) b = before.to;
  }
  const $a = doc.resolve(a);
  if ($a.parentOffset === $a.parent.content.size) {
    const after = Selection.findFrom($a, 1, true);
    if (after && after.from < b) a = after.from;
  }
  if (b <= a) return null;
  // Only whitespace (an empty line selected): nothing to pick. Inline atoms (an image) count as content.
  return /\S/.test(doc.textBetween(a, b, ' ', '￼')) ? { from: a, to: b } : null;
}

/** The picks with `range` added: overlapping and touching ranges become one; sorted by position. */
export function addRange(picks: readonly RangePick[], range: RangePick): RangePick[] {
  const out: RangePick[] = [];
  let merged = { ...range };
  for (const p of [...picks].sort((x, y) => x.from - y.from)) {
    if (p.to < merged.from || p.from > merged.to) out.push({ ...p });
    else merged = { from: Math.min(p.from, merged.from), to: Math.max(p.to, merged.to) };
  }
  out.push(merged);
  return out.sort((x, y) => x.from - y.from);
}

/** Is the position inside (or at the edge of) one of the picks? */
export const touches = (picks: readonly RangePick[], pos: number) => picks.some((p) => pos >= p.from && pos <= p.to);

/**
 * The picks after a change to the document: each moves with its text (typing before it shifts it; typing inside grows
 * it; typing at its edges stays outside), and one whose text is all gone is dropped. Works for other people's edits too:
 * the editor reports those as transactions with a mapping.
 */
export function mapRanges(picks: readonly RangePick[], mapping: Mapping, doc: PMNode): RangePick[] {
  const mapped: RangePick[] = [];
  for (const p of picks) {
    const from = mapping.map(p.from, 1);
    const to = mapping.map(p.to, -1);
    if (to > from && to <= doc.content.size) mapped.push({ from, to });
  }
  return mapped.reduce<RangePick[]>((acc, r) => addRange(acc, r), []);
}

/**
 * Where positions went across a change known only as the document before and after it: everything unchanged at the
 * start and the end stays put, what is between moved as one replacement. (The editor re-renders a whole box from the
 * shared document now and then, as one step replacing everything: mapping through that step alone would say all the
 * text was deleted and drop every pick, even though the text is the same.)
 */
export function diffMapping(before: PMNode, after: PMNode): Mapping {
  const start = before.content.findDiffStart(after.content);
  if (start == null) return new Mapping([]); // nothing changed
  const end = before.content.findDiffEnd(after.content)!;
  let { a: endA, b: endB } = end;
  const overlap = start - Math.min(endA, endB);
  if (overlap > 0) {
    endA += overlap;
    endB += overlap;
  }
  return new Mapping([new StepMap([start, endA - start, endB - start])]);
}

/** Did this change replace the whole document in one step (the editor re-rendering it from the shared document)? */
export function replacesWholeDoc(tr: Transform): boolean {
  return tr.steps.some((step, i) => step instanceof ReplaceStep && step.from === 0 && step.to === tr.docs[i].content.size);
}

const valid = (doc: PMNode, p: RangePick) => p.from >= 0 && p.to <= doc.content.size && p.from < p.to;

/** What the picks print as: each range as blocks, cut at both ends, formatting kept and list numbers continued, in document order. */
export function pickBlocks(doc: PMNode, picks: readonly RangePick[]): JSONContent[] {
  return [...picks]
    .sort((a, b) => a.from - b.from)
    .filter((p) => valid(doc, p))
    .flatMap((p) => selectionBlocks(TextSelection.create(doc, p.from, p.to)));
}

/** The picks as plain text: one range per line, in document order. */
export function pickText(doc: PMNode, picks: readonly RangePick[]): string {
  return [...picks]
    .sort((a, b) => a.from - b.from)
    .filter((p) => valid(doc, p))
    .map((p) => doc.textBetween(p.from, p.to, '\n', ' ').trim())
    .filter(Boolean)
    .join('\n');
}
