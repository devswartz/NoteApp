// The canvas's box clipboard: Copy / Cut / Paste / Duplicate of whole text boxes (CanvasEditor.tsx).
// What was copied is kept here, in the app, so it survives going to another page; the boxes' text is also
// put on the system clipboard, so Ctrl+V can tell "my boxes" from something copied since (and plain text
// pasted onto the canvas becomes a new box). No Yjs or DOM here: the pure parts are unit-tested.
import { create } from 'zustand';
import type { JSONContent } from '@tiptap/core';

/** One copied box: its geometry (as it was) and its blocks. */
export interface ClipBox {
  x: number;
  y: number;
  w: number;
  wide?: boolean;
  content: JSONContent[];
}

export interface Clip {
  boxes: ClipBox[];
  /** The boxes' text: what went on the system clipboard (to recognise our own copy on paste). */
  text: string;
  /** Cut, not copied: pasting moves the boxes, so their tasks keep being the same tasks. */
  cut: boolean;
  /** The text reached the system clipboard (the browser may refuse): until it has, an empty clipboard still means "ours". */
  synced?: boolean;
}

export const useBoxClipboard = create<{ clip: Clip | null }>(() => ({ clip: null }));

/** Plain text of some blocks: text runs, one line per block, tasks by their node text if any. */
export function jsonText(blocks: JSONContent[] | undefined): string {
  const lines: string[] = [];
  const walk = (n: JSONContent): string => {
    if (typeof n.text === 'string') return n.text;
    return (n.content ?? []).map(walk).join('');
  };
  const visit = (nodes: JSONContent[]) => {
    for (const n of nodes) {
      // Lists, tables, quotes and toggles hold blocks: one line per inner block.
      if (n.content?.some((c) => c.type && c.content)) visit(n.content);
      else lines.push(walk(n));
    }
  };
  visit(blocks ?? []);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export const clipText = (boxes: ClipBox[]) => boxes.map((b) => jsonText(b.content)).filter(Boolean).join('\n\n');

/** Blocks for pasted plain text: a paragraph per line. */
export function textBlocks(text: string): JSONContent[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => (line ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph' }));
}

export const PASTE_STEP = 24;

/**
 * Where pasted boxes go. With `at` (a right-click), the group's top-left lands there. Otherwise it keeps
 * its place, nudged down and right until it no longer sits exactly on a box that's already there (so a
 * second paste, or a duplicate, is visible).
 */
export function placeBoxes(boxes: ClipBox[], opts: { at?: { x: number; y: number }; existing: { x: number; y: number }[] }): ClipBox[] {
  if (!boxes.length) return [];
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  let dx = 0;
  let dy = 0;
  if (opts.at) {
    dx = opts.at.x - minX;
    dy = opts.at.y - minY;
  } else {
    const taken = (ox: number, oy: number) => boxes.some((b) => opts.existing.some((e) => Math.abs(e.x - (b.x + ox)) < 1 && Math.abs(e.y - (b.y + oy)) < 1));
    for (let i = 0; i < 40 && taken(dx, dy); i++) {
      dx += PASTE_STEP;
      dy += PASTE_STEP;
    }
  }
  return boxes.map((b) => ({ ...b, x: Math.max(0, Math.round(b.x + dx)), y: Math.max(0, Math.round(b.y + dy)) }));
}

/** The blocks with every task reference replaced by `clone(taskId)` (a new task): pasted boxes get their own tasks. */
export function mapTaskRefs(blocks: JSONContent[], clone: (taskId: string) => string | null): JSONContent[] {
  const walk = (n: JSONContent): JSONContent => {
    if (n.type === 'taskRef' && typeof n.attrs?.taskId === 'string') {
      const id = clone(n.attrs.taskId);
      return id ? { ...n, attrs: { ...n.attrs, taskId: id } } : n;
    }
    return n.content ? { ...n, content: n.content.map(walk) } : n;
  };
  return blocks.map(walk);
}
