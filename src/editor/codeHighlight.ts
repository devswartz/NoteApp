// Syntax highlighting for code blocks, incrementally.
//
// @tiptap/extension-code-block-lowlight's plugin walks the whole document twice on
// every transaction (to find code blocks), which dominated typing cost on long pages.
// This plugin computes decorations once on load, then only re-highlights the code
// blocks a transaction actually touched; everything else is mapped.
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { createLowlight } from 'lowlight';

type Lowlight = ReturnType<typeof createLowlight>;
interface HastNode {
  value?: string;
  children?: HastNode[];
  properties?: { className?: string[] };
}

function flatten(nodes: HastNode[], classes: string[] = []): { text: string; classes: string[] }[] {
  return nodes.flatMap((n) => {
    const cls = [...classes, ...(n.properties?.className ?? [])];
    return n.children ? flatten(n.children, cls) : [{ text: n.value ?? '', classes: cls }];
  });
}

/** Decorations for one code block at `pos`. */
export function blockDecorations(node: PMNode, pos: number, lowlight: Lowlight, defaultLanguage: string | null): Decoration[] {
  const text = node.textContent;
  if (!text) return [];
  const lang = (node.attrs.language as string | null) || defaultLanguage;
  const tree = lang && lowlight.registered(lang) ? lowlight.highlight(lang, text) : lowlight.highlightAuto(text);
  const out: Decoration[] = [];
  let from = pos + 1;
  for (const part of flatten(tree.children as HastNode[])) {
    const to = from + part.text.length;
    if (part.classes.length) out.push(Decoration.inline(from, to, { class: part.classes.join(' ') }));
    from = to;
  }
  return out;
}

/** Code blocks in [from, to], without descending into text. */
function blocksIn(doc: PMNode, from: number, to: number, name: string, found: Map<number, PMNode>) {
  doc.nodesBetween(Math.max(0, from), Math.min(doc.content.size, to), (node, pos) => {
    if (node.type.name === name) {
      found.set(pos, node);
      return false;
    }
    return !node.isTextblock;
  });
}

function allDecorations(doc: PMNode, name: string, lowlight: Lowlight, defaultLanguage: string | null) {
  const found = new Map<number, PMNode>();
  blocksIn(doc, 0, doc.content.size, name, found);
  const decos: Decoration[] = [];
  found.forEach((node, pos) => decos.push(...blockDecorations(node, pos, lowlight, defaultLanguage)));
  return DecorationSet.create(doc, decos);
}

/** Ranges (in the new document) that a transaction changed. */
export function changedRanges(tr: Transaction): [number, number][] {
  const ranges: [number, number][] = [];
  tr.mapping.maps.forEach((map, i) => {
    const rest = tr.mapping.slice(i + 1);
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      ranges.push([rest.map(newStart, -1), rest.map(newEnd, 1)]);
    });
  });
  return ranges;
}

export function codeHighlightPlugin({ name, lowlight, defaultLanguage }: { name: string; lowlight: Lowlight; defaultLanguage: string | null }) {
  const key = new PluginKey('codeHighlight');
  return new Plugin<DecorationSet>({
    key,
    state: {
      init: (_config, state: EditorState) => allDecorations(state.doc, name, lowlight, defaultLanguage),
      apply(tr, set) {
        if (!tr.docChanged) return set;
        let next = set.map(tr.mapping, tr.doc);
        const touched = new Map<number, PMNode>();
        // ±1 so a deletion (an empty range) still finds the block around it.
        for (const [from, to] of changedRanges(tr)) blocksIn(tr.doc, from - 1, to + 1, name, touched);
        touched.forEach((node, pos) => {
          next = next.remove(next.find(pos, pos + node.nodeSize));
          next = next.add(tr.doc, blockDecorations(node, pos, lowlight, defaultLanguage));
        });
        return next;
      },
    },
    props: {
      decorations: (state) => key.getState(state),
    },
  });
}
