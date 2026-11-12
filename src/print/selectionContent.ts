// What "Print selection" prints (pure: no DOM or store, so tests/printSelection.test.ts runs it
// in node). A text selection in a box becomes the blocks it covers, cut where the selection
// starts and ends, with formatting kept; numbered lists keep their original numbers. Selected
// boxes (Ctrl/Cmd+click) are printed whole, in reading order (printDoc's layout).
import type { JSONContent } from '@tiptap/core';
import { Fragment, type Node as PMNode, type ResolvedPos } from '@tiptap/pm/model';
import type { Selection } from '@tiptap/pm/state';
import { listStarts } from '../../shared/listMarker.ts';

/** Add `id` to the picked boxes, or take it out if it's there. */
export function toggleId(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}

/** The number an ordered list (the `index`-th child of `parent`) starts at, following `continued` lists. */
function effectiveStart(parent: PMNode, index: number): number {
  const infos: Parameters<typeof listStarts>[0] = [];
  parent.forEach((c) =>
    infos.push({ ordered: c.type.name === 'orderedList', start: Number(c.attrs.start) || 1, continued: !!c.attrs.continued, items: c.childCount }),
  );
  return listStarts(infos)[index] ?? 1;
}

const renumbered = (node: PMNode, start: number) => node.type.create({ ...node.attrs, start, continued: false }, node.content, node.marks);

/**
 * Ordered lists in a cut keep their numbers: a list cut at its 3rd item starts at 3, and a list
 * that carried on from an earlier one keeps counting from there. `parent` is the original node
 * holding the cut's top-level nodes, from child `first` on; `$from` is where the cut starts.
 */
function keepNumbers(frag: Fragment, parent: PMNode, first: number, $from: ResolvedPos, depth: number, open: number): Fragment {
  const out: PMNode[] = [];
  frag.forEach((node, _o, i) => {
    let n = node;
    const index = first + i;
    // The first node of an open cut is the original's ancestor at depth+1: its children start at $from.index(depth+1).
    const cutInside = i === 0 && open > 0;
    const skipped = cutInside ? $from.index(depth + 1) : 0;
    if (n.type.name === 'orderedList') n = renumbered(n, effectiveStart(parent, index) + skipped);
    if (cutInside && n.childCount) n = n.copy(keepNumbers(n.content, $from.node(depth + 1), skipped, $from, depth + 1, open - 1));
    out.push(n);
  });
  return Fragment.fromArray(out);
}

/** The selected content as blocks (editor JSON), or [] when nothing is selected. */
export function selectionBlocks(sel: Selection): JSONContent[] {
  if (sel.empty) return [];
  const slice = sel.content();
  let frag = slice.content;
  // A text (or whole-document) selection is a cut of the document at the two ends: its lists
  // keep their numbers. Cell and node selections are whole cells or nodes, numbered as they are.
  const type = (sel.toJSON() as { type?: string }).type;
  // Selection.content() keeps the parents of both ends (from the document down), so text picked
  // inside a list item still prints as that numbered item, and a table cell as a table.
  if (type === 'text' || type === 'all') {
    const { $from } = sel;
    frag = keepNumbers(frag, $from.doc, $from.index(0), $from, 0, slice.openStart);
  }
  // A selected inline node (an image in a line) prints in a paragraph of its own.
  if (frag.firstChild?.isInline) {
    const para = sel.$from.doc.type.schema.nodes.paragraph;
    if (para) frag = Fragment.from(para.create(null, frag));
  }
  const json: JSONContent[] = [];
  frag.forEach((n) => json.push(n.toJSON() as JSONContent));
  return json;
}
