// Dropping a dragged list item (the block handle's grip): keep its list's type and attributes. The handle library drops the bare item
// and ProseMirror wraps it in the first list type that fits, a bullet list, so a numbered item dropped below its list became a bullet.
// Here: dropped among list items it goes in as one (the default); dropped right before or after a list of its own type it joins that list
// (numbering carries on); dropped anywhere else it gets a new list of its own type and attributes (an ordered list starts at 1).
// Its sub-points travel with it and keep their own types. Pure ProseMirror, so tests/listDrop.test.ts runs it in node.
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { dropPoint } from '@tiptap/pm/transform';

const LIST_ITEMS = new Set(['listItem', 'taskItem']);
const isListNode = (n: PMNode | null | undefined) => !!n && n.childCount > 0 && LIST_ITEMS.has(n.firstChild!.type.name);

/**
 * The transaction that moves the selected list item to the drop position `pos` (a document position under the pointer), or null when
 * the default drop should be left to ProseMirror (not a list item, dropped among list items, or into itself).
 */
export function listDropTransaction(state: EditorState, pos: number): Transaction | null {
  const sel = state.selection;
  if (!(sel instanceof NodeSelection) || !LIST_ITEMS.has(sel.node.type.name)) return null;
  const { doc } = state;
  const item = sel.node;
  const source = sel.$from.parent;
  if (!isListNode(source)) return null;
  if (pos >= sel.from && pos <= sel.to) return null; // onto itself

  // Among list items (or where the item itself fits): ProseMirror's own drop puts it in that list as an item.
  const itemSlice = new Slice(Fragment.from(item), 0, 0);
  const asItem = dropPoint(doc, pos, itemSlice);
  if (asItem !== null && isListNode(doc.resolve(asItem).parent)) return null;

  // Anywhere else: where a whole list of the source's type fits.
  const wrapped = (items: Fragment, attrs = source.attrs) => source.type.create(attrs, items);
  const at = dropPoint(doc, pos, new Slice(Fragment.from(wrapped(Fragment.from(item))), 0, 0));
  if (at === null) return null;
  if (at >= sel.from && at <= sel.to) return null;
  const $at = doc.resolve(at);
  const before = $at.nodeBefore;
  const after = $at.nodeAfter;

  const tr = state.tr;
  // Source list with only this item: the whole (now empty) list goes, not just the item.
  const removeFrom = source.childCount === 1 ? sel.$from.before() : sel.from;
  const removeTo = source.childCount === 1 ? sel.$from.after() : sel.to;
  if (at >= removeFrom && at <= removeTo) return null;

  if (before && before.type === source.type && before !== source) tr.insert(at - 1, item); // joins the list before: numbering continues
  else if (before === source && before.type === source.type && at === sel.$from.after()) tr.insert(at - 1, item); // right below its own list: its last item
  else if (after && after.type === source.type) tr.insert(at + 1, item); // joins the list after
  else {
    // A new list of the source's type: an ordered one starts at 1 (its numbers don't continue from anywhere here).
    const attrs = source.type.name === 'orderedList' ? { ...source.attrs, start: 1, continued: false } : source.attrs;
    tr.insert(at, wrapped(Fragment.from(item), attrs));
  }
  tr.delete(tr.mapping.map(removeFrom, -1), tr.mapping.map(removeTo, 1));
  return tr.scrollIntoView().setMeta('uiEvent', 'drop');
}
