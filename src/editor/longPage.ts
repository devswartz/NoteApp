// Supports the long-page CSS (editor.css "Long pages"): marks the editor `is-long` when the
// page has many top-level blocks, and marks the blocks around the cursor `near-cursor`
// so the browser always fully renders the part of the page being edited.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export const LONG_PAGE_BLOCKS = 150;
const AROUND = 2;

export const LongPage = Extension.create({
  name: 'longPage',
  addProseMirrorPlugins() {
    const key = new PluginKey('longPage');
    return [
      new Plugin({
        key,
        props: {
          attributes: (state): Record<string, string> => (state.doc.childCount > LONG_PAGE_BLOCKS ? { class: 'is-long' } : {}),
          decorations(state) {
            const { doc, selection } = state;
            if (doc.childCount <= LONG_PAGE_BLOCKS) return null;
            // Top-level index of the cursor: O(1) from the resolved position.
            const index = selection.$head.index(0);
            const decos: Decoration[] = [];
            let pos = 0;
            for (let i = 0; i < doc.childCount; i++) {
              const node = doc.child(i);
              if (Math.abs(i - index) <= AROUND) decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'near-cursor' }));
              else if (i > index + AROUND) break;
              pos += node.nodeSize;
            }
            return DecorationSet.create(doc, decos);
          },
        },
      }),
    ];
  },
});
