// Picking separate lines inside and across boxes (Word-style multi-select): Ctrl/Cmd+click a paragraph, heading,
// list item or task line adds it to the picked lines (or takes it out), without moving the caret or dropping the
// ones picked before; Ctrl/Cmd+drag picks every line it sweeps over. Picked lines are drawn highlighted.
// "Print selection" prints exactly them, in reading order (src/print/print.ts), and Copy takes their text.
//
// ProseMirror has one real selection, so the picks are a plugin's own state per box editor: node ranges that
// move with edits (linePicksCore.ts). A Ctrl/Cmd+click on a box's frame still picks the whole box
// (CanvasEditor.tsx / boxSelection.ts), and on a link still opens it. Escape or a plain click clears them.
import { Extension, type Editor, type JSONContent } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { create } from 'zustand';
import { addLines, lineAt, linesBetween, mapPicks, pickBlocks, pickText, removeLines, samePick, toggleLine, type LinePick } from './linePicksCore.ts';

interface PickState {
  picks: LinePick[];
}
const key = new PluginKey<PickState>('linePicks');

/** How many lines are picked on the open page, per box (so the ribbon can offer "Print selection"). */
export const useLinePicks = create<{ pageId: string | null; byBox: Record<string, number> }>(() => ({ pageId: null, byBox: {} }));

interface Registered {
  pageId: string;
  boxId: string;
  editor: Editor;
}
const registry = new Set<Registered>();

const picksOf = (editor: Editor): LinePick[] => (editor.isDestroyed ? [] : (key.getState(editor.state)?.picks ?? []));
const forPage = (pageId: string) => [...registry].filter((r) => r.pageId === pageId && !r.editor.isDestroyed);

function report(r: Registered, n: number) {
  useLinePicks.setState((s) => {
    const byBox = s.pageId === r.pageId ? { ...s.byBox } : {};
    if (n) byBox[r.boxId] = n;
    else delete byBox[r.boxId];
    return { pageId: r.pageId, byBox };
  });
}

/** The app's side of picked lines: counts, text, blocks and clearing, across every box of a page. */
export const linePicks = {
  count: (pageId: string) => forPage(pageId).reduce((n, r) => n + picksOf(r.editor).length, 0),
  /** Picked lines as blocks, per box id (boxes with none are left out). */
  blocks(pageId: string): Record<string, JSONContent[]> {
    const out: Record<string, JSONContent[]> = {};
    for (const r of forPage(pageId)) {
      const picks = picksOf(r.editor);
      if (picks.length) out[r.boxId] = pickBlocks(r.editor.state.doc, picks);
    }
    return out;
  },
  /** Picked lines as plain text, boxes in the order they are on screen. */
  text(pageId: string): string {
    const top = (r: Registered) => {
      const b = r.editor.view.dom.getBoundingClientRect();
      return [Math.round(b.top / 20), b.left] as const;
    };
    return forPage(pageId)
      .filter((r) => picksOf(r.editor).length)
      .sort((a, b) => top(a)[0] - top(b)[0] || top(a)[1] - top(b)[1])
      .map((r) => pickText(r.editor.state.doc, picksOf(r.editor)))
      .filter(Boolean)
      .join('\n');
  },
  clear(pageId: string) {
    for (const r of forPage(pageId)) if (picksOf(r.editor).length) r.editor.view.dispatch(r.editor.state.tr.setMeta(key, { set: [] }).setMeta('addToHistory', false));
  },
  /** Is `el` (a DOM node in a box) on a picked line? */
  isPicked: (el: Element | null) => !!el?.closest?.('.is-line-picked'),
};

const extensionOptions = (editor: Editor, name: string) => editor.extensionManager.extensions.find((x) => x.name === name)?.options as Record<string, unknown> | undefined;

export const LinePicks = Extension.create({
  name: 'linePicks',
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin<PickState>({
        key,
        state: {
          init: () => ({ picks: [] }),
          apply(tr, value) {
            const meta = tr.getMeta(key) as { set?: LinePick[] } | undefined;
            if (meta?.set) return { picks: meta.set };
            if (!tr.docChanged || !value.picks.length) return value;
            return { picks: mapPicks(value.picks, tr.mapping, tr.doc) };
          },
        },
        props: {
          decorations(state) {
            const picks = key.getState(state)?.picks ?? [];
            return picks.length ? DecorationSet.create(state.doc, picks.map((p) => Decoration.node(p.from, p.to, { class: 'is-line-picked' }))) : null;
          },
        },
        view(view) {
          // This box's id and page, from its Collaboration field ("box:<id>") and the task node's page.
          const field = String(extensionOptions(editor, 'collaboration')?.field ?? '');
          const pageId = String(extensionOptions(editor, 'taskRef')?.pageId ?? '');
          const me: Registered | null = field.startsWith('box:') && pageId ? { pageId, boxId: field.slice(4), editor } : null;
          if (me) registry.add(me);
          let last = 0;

          const set = (picks: LinePick[]) => view.dispatch(view.state.tr.setMeta(key, { set: picks }).setMeta('addToHistory', false));
          const current = () => key.getState(view.state)?.picks ?? [];

          // Capture phase on the editor's root: it must also see presses inside node views (a task's title field).
          const onDown = (e: MouseEvent) => {
            if (e.button !== 0 || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
            const t = e.target as HTMLElement | null;
            // A link still opens; the blank area of the box (the editor's own padding) is the box's frame: it picks the box.
            if (!t || t === view.dom || t.closest('a[href]')) return;
            const at = view.posAtCoords({ left: e.clientX, top: e.clientY });
            if (!at) return;
            const hit = at.inside >= 0 ? view.state.doc.nodeAt(at.inside) : null;
            const line: LinePick | null = hit && hit.isBlock && hit.isAtom ? { from: at.inside, to: at.inside + hit.nodeSize, node: true } : lineAt(view.state.doc, at.pos);
            if (!line) return;
            e.preventDefault();
            e.stopPropagation(); // not the caret, not the box's own pick
            const before = current();
            const removing = before.some((p) => samePick(p, line));
            set(toggleLine(before, line));
            // Ctrl/Cmd+drag: every line swept over is picked (or, starting on a picked one, unpicked).
            const move = (ev: MouseEvent) => {
              const to = view.posAtCoords({ left: ev.clientX, top: ev.clientY });
              if (!to) return;
              const swept = linesBetween(view.state.doc, line.from, to.pos);
              set(removing ? removeLines(before, swept) : addLines(before, swept));
            };
            const up = () => {
              document.removeEventListener('mousemove', move);
              document.removeEventListener('mouseup', up);
            };
            document.addEventListener('mousemove', move);
            document.addEventListener('mouseup', up);
          };
          view.dom.addEventListener('mousedown', onDown, true);

          return {
            update() {
              const n = current().length;
              if (me && n !== last) {
                last = n;
                report(me, n);
              }
            },
            destroy() {
              view.dom.removeEventListener('mousedown', onDown, true);
              if (me) {
                registry.delete(me);
                report(me, 0);
              }
            },
          };
        },
      }),
    ];
  },
});
