// Word-style outlines: typed list markers, Tab / Shift+Tab nesting, Enter on an empty item
// outdents. Markers per level (1. → a. → i. → 1) …) come from CSS (editor.css), so the doc
// stores only the list structure and collaboration never fights over numbers.
import { Extension, wrappingInputRule, type CommandProps, type Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

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
export const letterListInputRegex = /^([aAiI])([.)])\s$/;
/** "1) " (TipTap's own rule covers "1. "). */
export const parenListInputRegex = /^(\d+)\)\s$/;

/**
 * Lift the list item at the selection one level out. When that takes a top-level item out of
 * the middle of a numbered list, the list splits around it, and the part after it is marked
 * `continued` so its numbers carry on (Word) instead of restarting at 1.
 */
function liftAndContinue(itemType: string, { state, chain }: CommandProps) {
  const { $from } = state.selection;
  let depth = -1;
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === itemType) {
    depth = d;
    break;
  }
  if (depth < 1) return false;
  const list = $from.node(depth - 1);
  const splits = depth === 2 && list.type.name === 'orderedList' && $from.index(depth - 1) > 0 && $from.index(depth - 1) < list.childCount - 1;
  return chain()
    .liftListItem(itemType)
    .command(({ tr }) => {
      if (!splits) return true;
      const after = tr.selection.$from.after(1);
      const next = tr.doc.nodeAt(after);
      if (next?.type.name === 'orderedList') tr.setNodeMarkup(after, null, { ...next.attrs, start: 1, continued: true });
      return true;
    })
    .run();
}

/**
 * A `continued` list's first number, as a view-only `start` attribute: the number after the
 * numbered list before it, worked out on every change, so nothing is stored and collaborators
 * never conflict over it. (CSS counters can't do this: Chrome resets every <ol>.)
 */
export function continuedStarts(doc: PMNode): DecorationSet {
  const decos: Decoration[] = [];
  const visit = (node: PMNode, contentStart: number) => {
    let next = 1;
    node.forEach((child, offset) => {
      const pos = contentStart + offset;
      if (child.type.name === 'orderedList') {
        const start = child.attrs.continued ? next : Number(child.attrs.start) || 1;
        if (child.attrs.continued) decos.push(Decoration.node(pos, pos + child.nodeSize, { start: String(start) }));
        next = start + child.childCount;
      }
      if (!child.isTextblock && !child.isLeaf) visit(child, pos + 1);
    });
  };
  visit(doc, 0);
  return DecorationSet.create(doc, decos);
}

const continuedKey = new PluginKey<DecorationSet>('continuedLists');

export const SmartLists = Extension.create({
  name: 'smartLists',
  // Ahead of ListItem's own Tab / Enter.
  priority: 200,

  addGlobalAttributes() {
    return [
      {
        types: ['orderedList'],
        attributes: {
          // Typed as "1) " / "a) ": markers end in ")" at that level (data-marker, case-sensitive for "A" vs "a").
          paren: {
            default: false,
            parseHTML: (el) => (el.getAttribute('data-marker') ?? '').startsWith('paren'),
            renderHTML: (attrs) => (attrs.paren ? { 'data-marker': `paren-${attrs.type || '1'}` } : {}),
          },
          // Numbering carries on from the numbered list before it (see continuedStarts).
          continued: {
            default: false,
            parseHTML: (el) => el.hasAttribute('data-continue'),
            renderHTML: (attrs) => (attrs.continued ? { 'data-continue': '' } : {}),
          },
        },
      },
    ];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: continuedKey,
        state: {
          init: (_, state) => continuedStarts(state.doc),
          apply: (tr, old) => (tr.docChanged ? continuedStarts(tr.doc) : old),
        },
        props: { decorations: (state) => continuedKey.getState(state) },
      }),
    ];
  },

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
        (props) => {
          const { editor } = props;
          const item = listItemAt(editor);
          return !!item && liftAndContinue(item, props);
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
        return this.editor.commands.outdentListItem();
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
        getAttributes: (match) => ({ type: MARKER_TYPE[match[1]], start: 1, paren: match[2] === ')' }),
        // "a." starts a list: never merged into a list just above.
        joinPredicate: () => false,
      }),
      wrappingInputRule({
        find: parenListInputRegex,
        type,
        getAttributes: (match) => ({ start: +match[1], paren: true }),
        // "3) " right under items 1) and 2) continues them, as TipTap does for "3. ".
        joinPredicate: (match, node: PMNode) => !node.attrs.type && !!node.attrs.paren && node.childCount + (node.attrs.start ?? 1) === +match[1],
      }),
    ];
  },
});
