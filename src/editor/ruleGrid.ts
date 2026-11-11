// Rule-line grid (a page with rule lines on, see canvas.css `.has-rules`): text is set on
// one 28px unit, and every top-level block of a box gets a bottom margin that rounds its
// height up to whole units, so whatever follows (text after a table, an image, a callout,
// a code block…) lands back on the lines. The margins are node decorations, so ProseMirror
// draws them itself; with rule lines off there are none and nothing changes.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';

/** Below this (px) a block counts as already on the grid (sub-pixel layout noise). */
export const GRID_EPSILON = 0.5;

/** Extra space (px) that takes `bottom` (measured from the box's text origin) down to the next whole unit. */
export function padToUnit(bottom: number, unit: number): number {
  if (!(unit > 0)) return 0;
  const over = ((bottom % unit) + unit) % unit;
  if (over < GRID_EPSILON || unit - over < GRID_EPSILON) return 0;
  return Math.round((unit - over) * 100) / 100;
}

/**
 * New bottom margins for a box's top-level blocks, top to bottom. Each block is measured as
 * laid out now (`bottom` from the text origin, with the current margins `pad` of the blocks
 * above it applied), so a changed margin shifts every later block before it is padded.
 */
export function gridPads(blocks: { bottom: number; pad: number }[], unit: number): number[] {
  let shift = 0;
  return blocks.map(({ bottom, pad }) => {
    const next = padToUnit(bottom + shift, unit);
    shift += next - pad;
    return next;
  });
}

const key = new PluginKey<DecorationSet>('ruleGrid');

/** The grid unit in px when the editor sits on a ruled page, else 0. */
function unitOf(view: EditorView): number {
  if (!view.dom.closest('.has-rules')) return 0;
  return parseFloat(getComputedStyle(view.dom).getPropertyValue('--rule')) || 0;
}

function measure(view: EditorView) {
  if (view.isDestroyed) return;
  const current = key.getState(view.state) ?? DecorationSet.empty;
  const unit = unitOf(view);
  if (!unit) {
    if (current !== DecorationSet.empty) view.dispatch(view.state.tr.setMeta(key, DecorationSet.empty).setMeta('addToHistory', false));
    return;
  }
  const r = view.dom.getBoundingClientRect();
  const origin = r.top + view.dom.clientTop + (parseFloat(getComputedStyle(view.dom).paddingTop) || 0);
  const blocks: { from: number; to: number; bottom: number; pad: number }[] = [];
  view.state.doc.forEach((node, offset) => {
    const el = view.nodeDOM(offset);
    if (!(el instanceof HTMLElement)) return;
    const pad = (current.find(offset, offset + node.nodeSize, (s) => typeof s.pad === 'number')[0]?.spec.pad as number | undefined) ?? 0;
    blocks.push({ from: offset, to: offset + node.nodeSize, bottom: el.getBoundingClientRect().bottom - origin, pad });
  });
  const pads = gridPads(blocks, unit);
  if (pads.every((p, i) => Math.abs(p - blocks[i]!.pad) < 0.05)) return;
  const decos = blocks.flatMap((b, i) => (pads[i]! > 0 ? [Decoration.node(b.from, b.to, { style: `margin-bottom: ${pads[i]}px` }, { pad: pads[i] })] : []));
  view.dispatch(view.state.tr.setMeta(key, DecorationSet.create(view.state.doc, decos)).setMeta('addToHistory', false));
}

export const RuleGrid = Extension.create({
  name: 'ruleGrid',
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: () => DecorationSet.empty,
          apply: (tr, set) => (tr.getMeta(key) as DecorationSet | undefined) ?? set.map(tr.mapping, tr.doc),
        },
        props: { decorations: (state) => key.getState(state) },
        view(view) {
          let frame = 0;
          const schedule = () => {
            if (!frame) frame = requestAnimationFrame(() => ((frame = 0), measure(view)));
          };
          // Size changes cover rule lines turned on/off (the line height changes), images
          // loading, a task title wrapping, and the box being made wider or narrower.
          const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
          ro?.observe(view.dom);
          schedule();
          return {
            update: (_v, prev) => {
              if (prev.doc !== view.state.doc) schedule();
            },
            destroy: () => {
              ro?.disconnect();
              if (frame) cancelAnimationFrame(frame);
            },
          };
        },
      }),
    ];
  },
});
