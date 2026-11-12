// Word-style outlines: typed list markers, Tab / Shift+Tab nesting, Enter on an empty item
// outdents. Markers per level (1. → a. → i. → 1) …) come from CSS (editor.css), so the doc
// stores only the list structure and collaboration never fights over numbers.
import { Extension, wrappingInputRule, type Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    smartLists: {
      /** Nest the list item at the selection one level deeper (Tab). */
      indentListItem: () => ReturnType;
      /** Move the list item at the selection one level out, or out of the list at the top level (Shift+Tab). */
      outdentListItem: () => ReturnType;
    };
  }
}

/** The list item type ('listItem' or 'taskItem') the selection is in, innermost first. */
export function listItemAt(editor: Editor): 'listItem' | 'taskItem' | null {
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const name = $from.node(d).type.name;
    if (name === 'listItem' || name === 'taskItem') return name;
    if (name === 'codeBlock' || name === 'tableCell' || name === 'tableHeader') return null;
  }
  return null;
}

/** HTML list type for a typed marker: "a" / "A" letters, "i" / "I" roman numerals. */
const MARKER_TYPE: Record<string, string> = { a: 'a', A: 'A', i: 'i', I: 'I' };

/** "a. " "A) " "i. " "I) " at the start of a line (the first marker of a sequence, as in Word). */
export const letterListInputRegex = /^([aAiI])[.)]\s$/;
/** "1) " (TipTap's own rule covers "1. "). */
export const parenListInputRegex = /^(\d+)\)\s$/;

export const SmartLists = Extension.create({
  name: 'smartLists',
  // Ahead of ListItem's own Tab / Enter.
  priority: 200,

  addCommands() {
    return {
      indentListItem:
        () =>
        ({ editor, commands }) => {
          const item = listItemAt(editor);
          return !!item && commands.sinkListItem(item);
        },
      outdentListItem:
        () =>
        ({ editor, commands }) => {
          const item = listItemAt(editor);
          return !!item && commands.liftListItem(item);
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      // In a list, Tab and Shift+Tab always belong to the list (nothing to nest under: stay put),
      // so they never jump to the next canvas box mid-outline.
      Tab: () => (listItemAt(this.editor) ? this.editor.commands.indentListItem() || true : false),
      'Shift-Tab': () => (listItemAt(this.editor) ? this.editor.commands.outdentListItem() || true : false),
      // Enter on an empty item: one level out, then out of the list (Word).
      Enter: () => {
        const { selection } = this.editor.state;
        const { $from, empty } = selection;
        if (!empty || $from.parent.content.size || !$from.parent.isTextblock || $from.depth < 2) return false;
        const item = $from.node(-1);
        if (item.type.name !== 'listItem' || item.childCount !== 1) return false;
        return this.editor.commands.liftListItem('listItem');
      },
    };
  },

  addInputRules() {
    const type = this.editor.schema.nodes.orderedList;
    if (!type) return [];
    return [
      wrappingInputRule({
        find: letterListInputRegex,
        type,
        getAttributes: (match) => ({ type: MARKER_TYPE[match[1]], start: 1 }),
        // "a." starts a list: never merged into a list just above.
        joinPredicate: () => false,
      }),
      wrappingInputRule({
        find: parenListInputRegex,
        type,
        getAttributes: (match) => ({ start: +match[1] }),
        // "3) " right under items 1 and 2 continues them, as TipTap does for "3. ".
        joinPredicate: (match, node: PMNode) => !node.attrs.type && node.childCount + (node.attrs.start ?? 1) === +match[1],
      }),
    ];
  },
});
