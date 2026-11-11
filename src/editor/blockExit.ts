// "Outdent first" for nested containers, like outlines in Word: Backspace on an empty
// line at the end of a toggle, callout or quote moves that line out, to just after the
// container, instead of deleting it and jumping back. A second Backspace then behaves
// as usual. Enter on an empty last line of a toggle exits the same way (callouts and
// quotes already do via ProseMirror's liftEmptyBlock; lists via ListKeymap, which also
// lifts a list item on Backspace at the start of its line).
import { Extension } from '@tiptap/core';
import { TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';

/** Containers whose empty last line leaves on Backspace. `detailsContent` exits its `details`. */
const BACKSPACE_CONTAINERS = new Set(['detailsContent', 'callout', 'blockquote']);

/**
 * Moves the empty paragraph at the cursor out of its container (toggle content, callout,
 * quote) to just after it, when it is the container's last line. One transaction, so one
 * undo restores it. `key` 'Enter' handles toggles only (the others lift on Enter already).
 * A toggle keeps one empty line when this was its only one; a callout or quote whose only
 * line it is is left to the usual unwrap.
 */
export function exitEmptyLastLine(state: EditorState, key: 'Backspace' | 'Enter', dispatch?: (tr: Transaction) => void): boolean {
  const { selection } = state;
  if (!selection.empty || !(selection instanceof TextSelection)) return false;
  const { $from } = selection;
  const line = $from.parent;
  if (line.type.name !== 'paragraph' || line.content.size !== 0 || $from.depth < 2) return false;
  const container = $from.node(-1);
  const name = container.type.name;
  if (key === 'Backspace' ? !BACKSPACE_CONTAINERS.has(name) : name !== 'detailsContent') return false;
  const index = $from.index(-1);
  if (index !== container.childCount - 1) return false;
  const only = container.childCount === 1;
  if (only && name !== 'detailsContent') return false;
  // The node the line leaves: the toggle itself for toggle content.
  const outerDepth = name === 'detailsContent' ? $from.depth - 2 : $from.depth - 1;
  if (outerDepth < 1 || (name === 'detailsContent' && $from.node(outerDepth).type.name !== 'details')) return false;
  const parent = $from.node(outerDepth - 1);
  const after = $from.indexAfter(outerDepth - 1);
  if (!parent.canReplaceWith(after, after, line.type)) return false;
  if (dispatch) {
    const tr = state.tr;
    if (!only) tr.delete($from.before(), $from.after());
    const pos = tr.mapping.map($from.after(outerDepth));
    tr.insert(pos, line.type.create());
    tr.setSelection(TextSelection.create(tr.doc, pos + 1));
    dispatch(tr.scrollIntoView());
  }
  return true;
}

export const BlockExit = Extension.create({
  name: 'blockExit',
  // Before the toggle's own Enter, the callout's Backspace and the base keymap.
  priority: 1000,
  addKeyboardShortcuts() {
    const run = (key: 'Backspace' | 'Enter') => () => {
      const { state, view } = this.editor;
      return exitEmptyLastLine(state, key, view.dispatch);
    };
    return { Backspace: run('Backspace'), Enter: run('Enter') };
  },
});
