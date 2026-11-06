// Keyboard alternative to dragging blocks: Alt+Shift+↑ / Alt+Shift+↓ moves the block
// at the cursor (or the selected block, e.g. an image or a task) up or down past its
// neighbour. Inside a list, the list item moves within its list; elsewhere the
// top-level block moves.
import { Extension } from '@tiptap/core';
import { NodeSelection, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    blockMove: {
      moveBlockUp: () => ReturnType;
      moveBlockDown: () => ReturnType;
    };
  }
}

const ITEMS = new Set(['listItem', 'taskItem']);

/** The block to move: the innermost list item around the selection, else the top-level block. */
export function movableBlock(state: EditorState): { depth: number } | null {
  const { $from } = state.selection;
  if (state.selection instanceof NodeSelection && $from.depth === 0) return { depth: 1 };
  for (let d = $from.depth; d > 0; d--) if (ITEMS.has($from.node(d).type.name)) return { depth: d };
  return $from.depth >= 1 ? { depth: 1 } : state.selection instanceof NodeSelection ? { depth: 1 } : null;
}

export function moveBlock(state: EditorState, dir: -1 | 1, dispatch?: (tr: Transaction) => void): boolean {
  const sel = state.selection;
  const target = movableBlock(state);
  if (!target) return false;
  // For a node selection at the top level, the node itself is the block.
  const isTopNode = sel instanceof NodeSelection && sel.$from.depth === 0;
  const $pos = sel.$from;
  const depth = isTopNode ? 0 : target.depth;
  const parent = isTopNode ? state.doc : $pos.node(depth - 1);
  const index = isTopNode ? $pos.index(0) : $pos.index(depth - 1);
  const node = isTopNode ? sel.node : $pos.node(depth);
  const start = isTopNode ? sel.from : $pos.before(depth);
  const swapIndex = index + dir;
  if (swapIndex < 0 || swapIndex >= parent.childCount) return false;
  const other = parent.child(swapIndex);
  if (!dispatch) return true;

  const offsetInBlock = sel.from - start;
  const tr = state.tr;
  if (dir === -1) {
    const otherStart = start - other.nodeSize;
    tr.delete(start, start + node.nodeSize).insert(otherStart, node);
    restore(tr, sel, otherStart, offsetInBlock);
  } else {
    const otherEnd = start + node.nodeSize + other.nodeSize;
    tr.insert(otherEnd, node).delete(start, start + node.nodeSize);
    restore(tr, sel, start + other.nodeSize, offsetInBlock);
  }
  dispatch(tr.scrollIntoView());
  return true;
}

function restore(tr: Transaction, sel: EditorState['selection'], newStart: number, offset: number) {
  if (sel instanceof NodeSelection) {
    tr.setSelection(NodeSelection.create(tr.doc, newStart + offset));
  } else {
    const pos = Math.min(newStart + offset, tr.doc.content.size);
    tr.setSelection(TextSelection.near(tr.doc.resolve(pos)));
  }
}

export const BlockMove = Extension.create({
  name: 'blockMove',
  addCommands() {
    return {
      moveBlockUp:
        () =>
        ({ state, dispatch }) =>
          moveBlock(state, -1, dispatch),
      moveBlockDown:
        () =>
        ({ state, dispatch }) =>
          moveBlock(state, 1, dispatch),
    };
  },
  addKeyboardShortcuts() {
    return {
      'Alt-Shift-ArrowUp': () => this.editor.commands.moveBlockUp(),
      'Alt-Shift-ArrowDown': () => this.editor.commands.moveBlockDown(),
    };
  },
});
