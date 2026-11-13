// Page content for the AI connector (server/mcp/): reading a page as Markdown box by box, and
// turning Markdown or HTML from an AI app into canvas box content.
//
// Writes reuse the OneNote importer's converter (server/onenoteHtml.ts): Markdown is rendered to
// HTML with marked, and the HTML (untrusted, whatever the AI sends) is parsed by the importer's
// tolerant parser, which only ever emits node and mark types the editor's schema has. Then
// sanitizeContent (unsafe links) and, once in Yjs, sanitizeYDoc run as for every import.
// Images and file cards are dropped: an AI app could be steered by text on a page into adding an
// image whose URL carries data off to another site, fetched by everyone who opens the page.
// Markdown task items ("- [ ] …") become real Notivelo tasks on the page, as OneNote to-dos do.
import * as Y from 'yjs';
import { marked } from 'marked';
import { convertOneNotePage, jsonToYFragment, TODO_PREFIX, type PMNode, type Todo } from '../onenoteHtml.ts';
import { sanitizeContent } from '../../shared/urls.ts';
import { DEFAULT_FIELD, boxField, boxGeoms, fragmentIsEmpty, readingOrder } from '../../shared/pageDoc.ts';
import { markdownBody, type TaskLookup } from '../markdown.ts';
import { HttpError } from '../http.ts';
import { MAX_NODE_DEPTH } from '../collab.ts';

/** Largest Markdown/HTML body one write accepts (characters). */
export const MAX_WRITE_CHARS = 100_000;
/** Most tasks one write may create from "- [ ]" items. */
export const MAX_WRITE_TODOS = 50;
/** Default and largest size of read_page's output (characters). */
export const READ_DEFAULT_CHARS = 50_000;
export const READ_MAX_CHARS = 200_000;
/** Deepest content a write may nest (below the collab server's own limit, which would remove it). */
const MAX_WRITE_DEPTH = MAX_NODE_DEPTH - 16;

export type Format = 'markdown' | 'html';

export interface Prepared {
  /** Block content, with `onenote-todo:<n>` placeholders in taskRef nodes (see fillTasks). */
  blocks: PMNode[];
  todos: Todo[];
}

/** Markdown → HTML, with task-list items marked as to-dos the way OneNote marks them (data-tag). */
export function markdownToHtml(md: string): string {
  const html = marked.parse(md, { async: false, gfm: true }) as string;
  // marked writes `<li><input [checked=""] disabled="" type="checkbox"> text</li>` (with <p> in loose lists).
  return html.replace(/<li>(\s*<p>)?\s*<input\b([^>]*)>\s?/g, (m, p: string | undefined, attrs: string) => {
    if (!/type="checkbox"/.test(attrs)) return m;
    return `<li data-tag="${/\bchecked\b/.test(attrs) ? 'to-do:completed' : 'to-do'}">${p ?? ''}`;
  });
}

function depth(n: PMNode): number {
  return 1 + Math.max(0, ...(n.content ?? []).map(depth));
}

/** Drop images and file cards (see the top of this file). */
function dropMedia(nodes: PMNode[]): PMNode[] {
  return nodes
    .filter((n) => n.type !== 'image' && n.type !== 'fileAttachment')
    .map((n) => (n.content ? { ...n, content: dropMedia(n.content) } : n));
}

const isEmptyParagraph = (n: PMNode) => n.type === 'paragraph' && !n.content?.length;

/** Convert an AI app's Markdown or HTML into block content. Throws HttpError 400 when it can't be used. */
export function prepareContent(content: string, format: Format): Prepared {
  if (content.length > MAX_WRITE_CHARS) throw new HttpError(413, `Content is too long (at most ${MAX_WRITE_CHARS} characters per call)`);
  const html = format === 'html' ? content : markdownToHtml(content);
  // A fallback title stops the converter reading <title>; the title is set separately.
  const converted = convertOneNotePage(html, 'x');
  const doc = sanitizeContent({ type: 'doc', content: dropMedia(converted.doc.content) } as PMNode);
  if (depth(doc) > MAX_WRITE_DEPTH) throw new HttpError(400, 'Content is nested too deeply');
  const blocks = (doc.content ?? []).filter((n, i, all) => !(isEmptyParagraph(n) && all.length === 1));
  if (converted.todos.length > MAX_WRITE_TODOS) throw new HttpError(400, `Too many task items (at most ${MAX_WRITE_TODOS} per call)`);
  return { blocks, todos: converted.todos };
}

/** Replace to-do placeholders with real task ids (created by the caller); placeholders without one are dropped. */
export function fillTasks(blocks: PMNode[], ids: Map<string, string>): PMNode[] {
  const out: PMNode[] = [];
  for (const n of blocks) {
    if (n.type === 'taskRef') {
      const key = String(n.attrs?.taskId ?? '');
      const id = key.startsWith(TODO_PREFIX) ? ids.get(key) : undefined;
      if (id) out.push({ type: 'taskRef', attrs: { taskId: id } });
      continue;
    }
    out.push(n.content ? { ...n, content: fillTasks(n.content, ids) } : n);
  }
  return out;
}

/** Append blocks to the end of a fragment (built in a scratch doc, then copied in). */
export function appendBlocks(frag: Y.XmlFragment, blocks: PMNode[]) {
  if (!blocks.length) return;
  const scratch = new Y.Doc();
  try {
    const tmp = scratch.getXmlFragment('tmp');
    jsonToYFragment({ type: 'doc', content: blocks }, tmp);
    frag.insert(frag.length, tmp.toArray().map((n) => (n as Y.XmlElement | Y.XmlText).clone()));
  } finally {
    scratch.destroy();
  }
}

// ───────── Reading ─────────

export interface BoxText {
  /** Box id (`box:<id>` fragment), or 'default' for a legacy document page's content. */
  id: string;
  markdown: string;
}

/** A page's content as Markdown, one entry per box in reading order (empty boxes skipped). */
export function pageBoxes(doc: Y.Doc, tasks: TaskLookup): BoxText[] {
  const out: BoxText[] = [];
  const def = doc.getXmlFragment(DEFAULT_FIELD);
  if (!fragmentIsEmpty(def)) out.push({ id: DEFAULT_FIELD, markdown: markdownBody(def, tasks) });
  for (const b of readingOrder(boxGeoms(doc))) {
    const frag = doc.getXmlFragment(boxField(b.id));
    if (fragmentIsEmpty(frag)) continue;
    out.push({ id: b.id, markdown: markdownBody(frag, tasks) });
  }
  return out;
}

/** Cut text to `max` characters, saying so. */
export function capText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return {
    text: `${text.slice(0, max)}\n\n[Truncated: showing ${max} of ${text.length} characters. Call read_page again with a larger max_chars (up to ${READ_MAX_CHARS}) to see more.]`,
    truncated: true,
  };
}

// ───────── Placing a new box ─────────

const textLen = (n: Y.XmlElement | Y.XmlText): number =>
  n instanceof Y.XmlText ? n.length : n.toArray().reduce((s, c) => s + textLen(c as Y.XmlElement | Y.XmlText), 0);

/** A rough height in page pixels (the editor sizes boxes to their content; the server can only guess). */
function blockHeight(n: Y.XmlElement | Y.XmlText): number {
  if (n instanceof Y.XmlText) return 28;
  const kids = n.toArray() as (Y.XmlElement | Y.XmlText)[];
  switch (n.nodeName) {
    case 'heading':
      return 44;
    case 'paragraph':
      return 28 * Math.max(1, Math.ceil(textLen(n) / 80));
    case 'image':
      return 260;
    case 'taskRef':
      return 32;
    case 'horizontalRule':
      return 24;
    case 'codeBlock':
      return 24 + 20 * Math.max(1, n.toString().split('\n').length);
    case 'table':
      return 36 * Math.max(1, kids.length);
    default:
      return kids.length ? kids.reduce((s, c) => s + blockHeight(c), 0) : 28;
  }
}

export function estimateBoxHeight(frag: Y.XmlFragment): number {
  return 24 + (frag.toArray() as (Y.XmlElement | Y.XmlText)[]).reduce((s, n) => s + blockHeight(n), 0);
}
