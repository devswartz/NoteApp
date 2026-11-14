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

export const clipText = (boxes: ClipBox[], taskText?: TaskText) => boxes.map((b) => blocksText(b.content, taskText)).filter(Boolean).join('\n\n');

/** A task's line in plain text: "[ ] title" / "[x] title". */
export type TaskText = (taskId: string) => string;

const listMarker = (list: JSONContent, i: number) => (list.type === 'orderedList' ? `${(Number(list.attrs?.start) || 1) + i}.` : '-');
const inlineText = (n: JSONContent): string => (n.type === 'hardBreak' ? '\n' : typeof n.text === 'string' ? n.text : (n.content ?? []).map(inlineText).join(''));
const TEXT_BLOCKS = new Set(['paragraph', 'heading', 'codeBlock']);

/**
 * Blocks as plain text with the list markers kept: "- " for bullets, "1. " for numbers (from the list's own start),
 * two spaces of indent per nesting level, a tab between table cells, tasks as "[ ] title". What goes on the clipboard
 * next to the HTML, and what another app that only takes text gets.
 */
export function blocksText(blocks: JSONContent[] | undefined, taskText?: TaskText): string {
  const lines: string[] = [];
  const visit = (nodes: JSONContent[], depth: number) => {
    for (const n of nodes) {
      const pad = '  '.repeat(depth);
      if (n.type === 'bulletList' || n.type === 'orderedList') {
        (n.content ?? []).forEach((item, i) => {
          const [lead, ...rest] = item.content ?? [];
          lines.push(`${pad}${listMarker(n, i)} ${lead ? inlineText(lead) : ''}`);
          visit(rest, depth + 1);
        });
      } else if (n.type === 'taskRef') {
        lines.push(`${pad}${taskText?.(String(n.attrs?.taskId ?? '')) ?? '[ ]'}`);
        visit(n.content ?? [], depth + 1); // the notes under the task
      } else if (n.type === 'table') {
        for (const row of n.content ?? []) lines.push(pad + (row.content ?? []).map((c) => (c.content ?? []).map(inlineText).join(' ')).join('\t'));
      } else if (n.content?.some((c) => c.type && !TEXT_BLOCKS.has(c.type) && c.type !== 'text' && c.type !== 'hardBreak' ? true : TEXT_BLOCKS.has(c.type ?? ''))) {
        visit(n.content, depth); // quotes, callouts, toggles: their blocks, one line each
      } else lines.push(pad + inlineText(n));
    }
  };
  visit(blocks ?? [], 0);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const LIST_LINE = /^([ \t]*)([-*•]|\d{1,4}[.)])[ \t]+(.*)$/;

/**
 * Blocks for pasted plain text: a paragraph per line, except that lines starting "- ", "* ", "• " or "1. " / "1) " become
 * list items (a deeper indent, 2 spaces or a tab more, nests; a numbered list starts at its first number).
 */
export function textBlocks(text: string): JSONContent[] {
  const out: JSONContent[] = [];
  type Open = { indent: number; list: JSONContent };
  let stack: Open[] = [];
  const para = (t: string): JSONContent => (t ? { type: 'paragraph', content: [{ type: 'text', text: t }] } : { type: 'paragraph' });
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const m = LIST_LINE.exec(line);
    if (!m || !m[3]!.trim()) {
      stack = [];
      out.push(para(line));
      continue;
    }
    const indent = m[1]!.replace(/\t/g, '  ').length;
    const ordered = /\d/.test(m[2]!);
    const type = ordered ? 'orderedList' : 'bulletList';
    while (stack.length && stack[stack.length - 1]!.indent > indent) stack.pop();
    let top = stack[stack.length - 1];
    if (top && top.indent === indent && top.list.type !== type) {
      stack.pop();
      top = stack[stack.length - 1];
    }
    const item: JSONContent = { type: 'listItem', content: [para(m[3]!.trim())] };
    if (top && top.indent === indent) top.list.content!.push(item);
    else {
      const list: JSONContent = { type, ...(ordered ? { attrs: { start: Number.parseInt(m[2]!, 10) || 1, type: null } } : {}), content: [item] };
      const parent = stack[stack.length - 1];
      if (parent) parent.list.content![parent.list.content!.length - 1]!.content!.push(list);
      else out.push(list);
      stack.push({ indent, list });
    }
  }
  return out;
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
    const out = n.content ? { ...n, content: n.content.map(walk) } : n; // subtasks in a task's notes get their own copies too
    if (n.type === 'taskRef' && typeof n.attrs?.taskId === 'string') {
      const id = clone(n.attrs.taskId);
      return id ? { ...out, attrs: { ...n.attrs, taskId: id } } : out;
    }
    return out;
  };
  return blocks.map(walk);
}
