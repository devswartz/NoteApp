// Word-style multi-selection inside and across boxes. The first selection is entirely the browser's own: drag,
// double-click a word, triple-click a line. Holding Ctrl/Cmd for the next gesture keeps the earlier selection as a
// "pick" (an exact character range, highlighted like a selection) while the browser makes the new one: Ctrl+drag
// adds that range, Ctrl+double-click the word, Ctrl+triple-click the line. A Ctrl/Cmd+click without a drag adds
// nothing new (it just places the caret) but keeps the earlier selection picked, so nothing is lost by accident.
// "Print selection" prints exactly the picked ranges plus the live selection, in reading order (src/print/print.ts);
// Copy takes their text.
//
// ProseMirror has one real selection, so the picks are a plugin's own state per box editor: ranges that move with
// edits, others' included (linePicksCore.ts). Kept as they were: Ctrl/Cmd+click on a link opens it, on a box's frame
// picks the whole box (CanvasEditor.tsx / boxSelection.ts); Escape or a plain click clears everything.
import { Extension, type Editor, type JSONContent } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { create } from 'zustand';
import { addRange, diffMapping, mapRanges, pickBlocks, pickText, rangeOf, replacesWholeDoc, touches, type RangePick } from './linePicksCore.ts';

interface PickState {
  picks: RangePick[];
}
const key = new PluginKey<PickState>('rangePicks');

/** How many ranges are picked on the open page, per box (so the ribbon can offer "Print selection"). */
export const useLinePicks = create<{ pageId: string | null; byBox: Record<string, number> }>(() => ({ pageId: null, byBox: {} }));

interface Registered {
  pageId: string;
  boxId: string;
  editor: Editor;
}
const registry = new Set<Registered>();
/**
 * The box editor that last had focus: the one holding the live (browser) selection. Kept as the editor itself, not its
 * registration: ProseMirror rebuilds a plugin's view whenever another plugin is registered (the drag handle does), and
 * the registration is made again with it.
 */
let activeEditor: Editor | null = null;
const activeReg = () => [...registry].find((r) => r.editor === activeEditor && alive(r)) ?? null;

const alive = (r: Registered) => !r.editor.isDestroyed;
const picksOf = (r: Registered): RangePick[] => (alive(r) ? (key.getState(r.editor.state)?.picks ?? []) : []);
const forPage = (pageId: string) => [...registry].filter((r) => r.pageId === pageId && alive(r));
const setPicks = (r: Registered, picks: RangePick[]) => r.editor.view.dispatch(r.editor.state.tr.setMeta(key, { set: picks }).setMeta('addToHistory', false));

/**
 * The live selection of an editor as a pick, or null when it is just a caret. The browser's own selection is the
 * truth for a gesture just made (the editor learns of it a moment later), so that is read first.
 */
function liveRange(r: Registered): RangePick | null {
  if (!alive(r)) return null;
  const { view } = r.editor;
  const dom = typeof window === 'undefined' ? null : window.getSelection();
  if (dom && !dom.isCollapsed && dom.anchorNode && dom.focusNode && view.dom.contains(dom.anchorNode) && view.dom.contains(dom.focusNode)) {
    try {
      return rangeOf(view.state.doc, view.posAtDOM(dom.anchorNode, dom.anchorOffset), view.posAtDOM(dom.focusNode, dom.focusOffset));
    } catch {
      // a position the editor can't place: fall back to its own state
    }
  }
  const { selection, doc } = r.editor.state;
  return selection.empty ? null : rangeOf(doc, selection.from, selection.to);
}

/** The picks of a box, plus the live selection when this box holds it (merged). */
function rangesOf(r: Registered): RangePick[] {
  const live = r.editor === activeEditor ? liveRange(r) : null;
  return live ? addRange(picksOf(r), live) : picksOf(r);
}

function report(r: Registered, n: number) {
  useLinePicks.setState((s) => {
    const byBox = s.pageId === r.pageId ? { ...s.byBox } : {};
    if (n) byBox[r.boxId] = n;
    else delete byBox[r.boxId];
    return { pageId: r.pageId, byBox };
  });
}

/** Turn the selection that is live right now into a pick, and leave a caret in its place. */
function commitLive(pageId: string) {
  const r = activeReg();
  if (!r || r.pageId !== pageId) return;
  const live = liveRange(r);
  if (!live) return;
  const { tr, doc } = r.editor.state;
  r.editor.view.dispatch(
    tr
      .setMeta(key, { set: addRange(picksOf(r), live) })
      .setSelection(TextSelection.create(doc, live.to))
      .setMeta('addToHistory', false),
  );
}

/** The app's side of picked text: counts, blocks, text, hit-testing and clearing, across every box of a page. */
export const linePicks = {
  /** How many ranges are picked (not counting the live selection). */
  count: (pageId: string) => forPage(pageId).reduce((n, r) => n + picksOf(r).length, 0),
  /** The picked ranges and the live selection as blocks, per box id; empty when nothing is picked. */
  blocks(pageId: string): Record<string, JSONContent[]> {
    const out: Record<string, JSONContent[]> = {};
    if (!linePicks.count(pageId)) return out;
    for (const r of forPage(pageId)) {
      const ranges = rangesOf(r);
      if (ranges.length) out[r.boxId] = pickBlocks(r.editor.state.doc, ranges);
    }
    return out;
  },
  /** The same as plain text, boxes in the order they are on screen. */
  text(pageId: string): string {
    const top = (r: Registered) => {
      const b = r.editor.view.dom.getBoundingClientRect();
      return [Math.round(b.top / 20), b.left] as const;
    };
    if (!linePicks.count(pageId)) return '';
    return forPage(pageId)
      .filter((r) => rangesOf(r).length)
      .sort((a, b) => top(a)[0] - top(b)[0] || top(a)[1] - top(b)[1])
      .map((r) => pickText(r.editor.state.doc, rangesOf(r)))
      .filter(Boolean)
      .join('\n');
  },
  /** Drop every pick; `collapse` (Escape) also turns the live selection into a caret. */
  clear(pageId: string, collapse = false) {
    for (const r of forPage(pageId)) if (picksOf(r).length) setPicks(r, []);
    const r = activeReg();
    if (collapse && r && r.pageId === pageId && !r.editor.state.selection.empty) {
      r.editor.view.dispatch(r.editor.state.tr.setSelection(TextSelection.create(r.editor.state.doc, r.editor.state.selection.to)).setMeta('addToHistory', false));
    }
    // The browser's own highlight, too: once the box has given up focus it would stay drawn.
    // Not while an editor still has focus: that would remove its caret too (Escape closing the slash menu, then Backspace).
    if (collapse && !forPage(pageId).some((e) => e.editor.view.hasFocus())) window.getSelection()?.removeAllRanges();
  },
  /** What a point on the page is on: a picked range, the live selection, or neither (a right-click uses it). */
  hit(pageId: string, target: Element | null, x: number, y: number): 'pick' | 'selection' | null {
    const r = forPage(pageId).find((e) => !!target && e.editor.view.dom.contains(target));
    if (!r) return null;
    const pos = r.editor.view.posAtCoords({ left: x, top: y })?.pos;
    if (pos === undefined) return null;
    if (touches(picksOf(r), pos)) return 'pick';
    const live = r.editor === activeEditor ? liveRange(r) : null;
    return live && pos >= live.from && pos <= live.to ? 'selection' : null;
  },
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
            const meta = tr.getMeta(key) as { set?: RangePick[] } | undefined;
            if (meta?.set) return { picks: meta.set };
            if (!tr.docChanged || !value.picks.length) return value;
            // A box re-rendered whole from the shared document keeps its picks: see diffMapping.
            return { picks: mapRanges(value.picks, replacesWholeDoc(tr) ? diffMapping(tr.before, tr.doc) : tr.mapping, tr.doc) };
          },
        },
        props: {
          decorations(state) {
            const picks = key.getState(state)?.picks ?? [];
            return picks.length ? DecorationSet.create(state.doc, picks.map((p) => Decoration.inline(p.from, p.to, { class: 'is-range-picked' }))) : null;
          },
        },
        view(view) {
          // This box's id and page, from its Collaboration field ("box:<id>") and the task node's page.
          const field = String(extensionOptions(editor, 'collaboration')?.field ?? '');
          const pageId = String(extensionOptions(editor, 'taskRef')?.pageId ?? '');
          const me: Registered | null = field.startsWith('box:') && pageId ? { pageId, boxId: field.slice(4), editor } : null;
          if (me) registry.add(me);
          let last = 0;

          // The editor that has focus holds the live selection.
          const onFocus = () => {
            if (me) activeEditor = editor;
          };
          // Capture phase on the editor's root, ahead of ProseMirror's own press handling (which, with Ctrl held, would
          // select a whole node instead of placing the caret).
          const onDown = (e: MouseEvent) => {
            // A right-click once something is picked: the browser moves the caret to it, so the selection made last
            // becomes a pick first (it would otherwise be forgotten, and only the older picks would print).
            if (me && e.button === 2 && linePicks.count(me.pageId) > 0) commitLive(me.pageId);
            if (!me || e.button !== 0 || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
            const t = e.target as HTMLElement | null;
            // A link still opens; a box's own padding is its frame (it picks the whole box); an inline task or other
            // node view keeps its own behaviour.
            if (!t || t === view.dom || t.closest('[contenteditable="false"]')) return;
            if (t.closest('a[href]')) {
              // The browser opens it as usual; the selection made so far stays picked.
              if (e.detail <= 1) commitLive(me.pageId);
              return;
            }
            if (e.detail <= 1) {
              // The selection made so far becomes a pick, whichever box holds it; then a caret at the click, so what is
              // highlighted isn't also the start of a drag-copy and the browser's own gesture starts from nothing.
              commitLive(me.pageId);
              const at = view.posAtCoords({ left: e.clientX, top: e.clientY });
              if (at) view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(at.pos))).setMeta('addToHistory', false));
            }
            // The browser now makes the new selection itself (drag, double-click, triple-click): its default is untouched.
            e.stopPropagation();
          };
          view.dom.addEventListener('mousedown', onDown, true);
          view.dom.addEventListener('focusin', onFocus);

          return {
            update() {
              const n = me ? picksOf(me).length : 0;
              if (me && n !== last) {
                last = n;
                report(me, n);
              }
            },
            destroy() {
              view.dom.removeEventListener('mousedown', onDown, true);
              view.dom.removeEventListener('focusin', onFocus);
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

