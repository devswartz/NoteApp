// Pages as printable DOM: a header (title, notebook › section, date) and the canvas boxes in
// a flow layout (./printLayout.ts), rendered statically from the page's Y.Doc with the editor
// schema. No editor, node view or collab session is created, so it is synchronous (it can run
// inside a `beforeprint` handler) and cheap enough for a whole section. The print styles are
// in src/styles/print.css.
import { getSchema, type JSONContent } from '@tiptap/core';
import { DOMSerializer, Node as PMNode, type Schema } from '@tiptap/pm/model';
import * as Y from 'yjs';
import { DEFAULT_FIELD, fragmentIsEmpty, readPageSettings } from '../../shared/pageDoc.ts';
import { parseISODate } from '../../shared/dates.ts';
import { sectionAncestry } from '../../shared/sections.ts';
import type { Member, Task, Tree } from '../../shared/types.ts';
import { canvasBoxes } from '../editor/canvasDoc.ts';
import { documentExtensions } from '../editor/NoteEditor.tsx';
import { sanitizeContent } from '../editor/urls.ts';
import { resolveListStarts } from '../../shared/listMarker.ts';
import { estimateBoxHeight, printRows, type PrintBox } from './printLayout.ts';
import { yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import '../styles/print.css';

/** Printable width (CSS px) of the narrower of A4 and Letter with the @page margins in print.css. */
export const PAPER_WIDTH_PX = 670;

export interface PrintPageInput {
  pageId: string;
  doc: Y.Doc;
  /** Measured canvas heights of the boxes (the open page); others are estimated. */
  heights?: Record<string, number>;
}

export interface PrintContext {
  tree: Tree;
  tasks: Record<string, Task>;
  members: Pick<Member, 'id' | 'name'>[];
  /** Print the page colour as a background (off by default: rule lines never print). */
  pageColour: boolean;
}

let schema: Schema | null = null;
/** The page schema (the same for every page; the page id only configures node behaviour). */
function printSchema(): Schema {
  return (schema ??= getSchema(documentExtensions('print')));
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const DATE = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const SHORT = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });

/** "12 Nov" (this year) or "12 Nov 2027": paper outlives "Tomorrow". */
export function printDue(date: string, time: string | null): string {
  const d = parseISODate(date);
  const day = d.getFullYear() === new Date().getFullYear() ? SHORT.format(d) : DATE.format(d);
  return time ? `${day} ${time}` : day;
}

/** A task reference as a compact checklist line: box, title, then due · assignee · priority in small muted type. */
export function taskLine(task: Task | undefined, members: PrintContext['members']): HTMLElement {
  const row = el('div', 'print-task');
  const box = el('span', 'print-check');
  box.setAttribute('aria-hidden', 'true');
  row.append(box);
  if (!task) {
    row.append(el('span', 'print-task-title print-muted', 'Task not available'));
    return row;
  }
  if (task.status === 'done') row.classList.add('is-done');
  row.append(el('span', 'print-task-title', task.title || 'Untitled task'));
  const meta = [
    task.dueDate ? printDue(task.dueDate, task.dueTime) : '',
    task.assigneeId ? (members.find((m) => m.id === task.assigneeId)?.name ?? '') : '',
    task.priority < 4 ? `P${task.priority}` : '',
  ].filter(Boolean);
  if (meta.length) row.append(el('span', 'print-task-meta', meta.join(' · ')));
  return row;
}

/** Static DOM of one box's content (editor JSON → schema's toDOM, as the editor would render it without node views). */
function contentDOM(json: JSONContent, ctx: PrintContext): HTMLElement {
  const s = printSchema();
  const wrap = el('div', 'print-box-content ProseMirror prose');
  const node = PMNode.fromJSON(s, resolveListStarts(sanitizeContent(json)));
  wrap.append(DOMSerializer.fromSchema(s).serializeFragment(node.content, { document }));
  // Task references hold only an id: draw the live task.
  wrap.querySelectorAll<HTMLElement>('div[data-type="task-ref"]').forEach((ref) => {
    ref.replaceWith(taskLine(ctx.tasks[ref.getAttribute('data-task-id') ?? ''], ctx.members));
  });
  // Collapsed toggles print open: nothing is lost on paper.
  wrap.querySelectorAll('details').forEach((d) => d.setAttribute('open', ''));
  // Images resized in the editor keep their width only up to the column's.
  wrap.querySelectorAll('img').forEach((img) => {
    img.loading = 'eager';
    img.decoding = 'sync';
  });
  return wrap;
}

/** "Notebook › Section › Subsection" for a page. */
export function pagePath(tree: Tree, sectionId: string): string {
  const chain = sectionAncestry(tree, sectionId);
  const nb = tree.notebooks.find((n) => n.id === chain[0]?.notebookId);
  return [nb?.name, ...chain.map((s) => s.name)].filter(Boolean).join(' › ');
}

/** One page, ready to print: header, then the boxes in rows. Starts on a new sheet when it isn't the first. */
export function renderPrintPage(input: PrintPageInput, ctx: PrintContext): HTMLElement {
  const meta = ctx.tree.pages.find((p) => p.id === input.pageId);
  const settings = readPageSettings(input.doc);
  const page = el('article', 'print-page');
  page.dataset.pageId = input.pageId;
  if (ctx.pageColour && settings.color !== 'none') page.dataset.pageColor = settings.color;

  const head = el('header', 'print-head');
  head.append(el('h1', 'print-title', `${meta?.icon ? `${meta.icon} ` : ''}${meta?.title || 'Untitled'}`));
  const sub = [meta ? pagePath(ctx.tree, meta.sectionId) : '', meta?.updatedAt ? DATE.format(new Date(meta.updatedAt)) : ''].filter(Boolean);
  if (sub.length) head.append(el('div', 'print-sub', sub.join(' · ')));
  page.append(head);

  const s = printSchema();
  const boxes: (PrintBox & { json: JSONContent })[] = canvasBoxes(input.doc, s).map((b) => ({
    id: b.id,
    x: b.x,
    y: b.y,
    w: b.w,
    wide: b.wide,
    h: input.heights?.[b.id] ?? estimateBoxHeight(b.json.content ?? []),
    json: b.json,
  }));
  // A legacy document page (content in `default`): one wide box above everything.
  const def = input.doc.getXmlFragment(DEFAULT_FIELD);
  if (!fragmentIsEmpty(def)) {
    const json = yXmlFragmentToProseMirrorRootNode(def, s).toJSON() as JSONContent;
    boxes.unshift({ id: DEFAULT_FIELD, x: 0, y: -1, w: 1, wide: true, h: 0, json });
  }
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const body = el('div', 'print-body');
  for (const row of printRows(boxes, PAPER_WIDTH_PX)) {
    const r = el('div', `print-row${row.ids.length > 1 ? ' is-columns' : ''}`);
    row.ids.forEach((id, i) => {
      const box = el('section', 'print-box');
      box.dataset.boxId = id;
      if (row.ids.length > 1) box.style.flex = `${row.widths[i]} 1 0`;
      box.append(contentDOM(byId.get(id)!.json, ctx));
      r.append(box);
    });
    body.append(r);
  }
  if (!boxes.length) body.append(el('p', 'print-muted', 'This page is empty.'));
  page.append(body);
  return page;
}

export const PRINT_ROOT_ID = 'print-root';

/** Replace the print root's content with these pages (creating it on first use). */
export function mountPrintRoot(pages: HTMLElement[]): HTMLElement {
  let root = document.getElementById(PRINT_ROOT_ID);
  if (!root) {
    root = el('div', 'print-root');
    root.id = PRINT_ROOT_ID;
    root.setAttribute('aria-hidden', 'true');
    document.body.append(root);
  }
  root.replaceChildren(...pages);
  document.documentElement.classList.add('print-job');
  return root;
}

/** Remove what was prepared for printing; printing again shows the app's own print view. */
export function clearPrintRoot() {
  document.getElementById(PRINT_ROOT_ID)?.remove();
  document.documentElement.classList.remove('print-job');
}

/** Wait (up to `ms`) for the printed images to load, so they aren't blank on paper. */
export async function imagesReady(root: HTMLElement, ms = 8000): Promise<void> {
  const imgs = [...root.querySelectorAll('img')].filter((i) => !i.complete);
  if (!imgs.length) return;
  await Promise.race([
    Promise.all(imgs.map((i) => new Promise<void>((res) => ((i.onload = () => res()), (i.onerror = () => res()))))),
    new Promise<void>((res) => setTimeout(res, ms)),
  ]);
}
