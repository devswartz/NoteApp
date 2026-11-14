// Copy that keeps the formatting, for the copies the app makes itself (a box, Ctrl+C on picked text, the right-click
// Copy): real HTML on the clipboard next to the text, so a paste into another box, another page or another app (Word,
// Outlook) keeps bullets, numbering, nesting, headings, bold and links. The HTML comes from the editor's own schema
// and carries ProseMirror's slice marker, so Notivelo-to-Notivelo pastes restore the structure exactly.
// Pasting HTML onto the empty canvas (a new box) is htmlToBlocks. The text side is blocksText (boxClipboard.ts).
import type { JSONContent } from '@tiptap/core';
import { DOMParser as PMDOMParser, DOMSerializer, Fragment, type Schema } from '@tiptap/pm/model';
import { sanitizeContent } from './urls.ts';
import { blocksText, type TaskText } from './boxClipboard.ts';
import { useStore } from '../store.ts';

/** "[ ] title" / "[x] title" for a task id, from the live task. */
export const taskLine: TaskText = (id) => {
  const t = useStore.getState().tasks[id];
  return `[${t?.status === 'done' ? 'x' : ' '}] ${t?.title ?? ''}`;
};

/** The blocks as HTML (ProseMirror's own serialisation), or '' when they can't be serialised. */
export function blocksToHtml(blocks: JSONContent[], schema: Schema): string {
  try {
    const fragment = Fragment.fromArray(blocks.map((b) => schema.nodeFromJSON(sanitizeContent(b))));
    const div = document.createElement('div');
    div.append(DOMSerializer.fromSchema(schema).serializeFragment(fragment));
    // A task holds only its id (and the notes under it); elsewhere it should read as its line, then its notes.
    // The line goes outside the notes element, so a paste back into Notivelo ignores it (TaskRef's parseHTML).
    div.querySelectorAll<HTMLElement>('[data-type="task-ref"]').forEach((el) => {
      const line = document.createElement('p');
      line.textContent = taskLine(el.getAttribute('data-task-id') ?? '');
      el.prepend(line);
    });
    div.firstElementChild?.setAttribute('data-pm-slice', '0 0 []'); // ProseMirror: a complete set of blocks, nothing open
    return div.innerHTML;
  } catch {
    return '';
  }
}

/**
 * Put blocks on the system clipboard as HTML and text. `text` is what goes in the text part (default: the blocks with
 * their list markers). Falls back to text alone where the browser has no rich clipboard or refuses it.
 */
export async function writeBlocks(blocks: JSONContent[], schema: Schema, text = blocksText(blocks, taskLine)): Promise<void> {
  const html = blocksToHtml(blocks, schema);
  if (html && typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]);
      return;
    } catch {
      // fall through to plain text
    }
  }
  await navigator.clipboard.writeText(text);
}

/** HTML that holds real structure (a list, a heading, a table, several paragraphs), not just a styled run of text. */
const STRUCTURED = /<(ul|ol|li|h[1-6]|table|blockquote|pre|p|div)[\s>]/i;

/**
 * Blocks for pasted HTML, as far as the editor's schema allows (anything else is dropped, links are checked). Null when
 * there is no HTML, or it is only a styled run of text: the caller then uses the plain text.
 */
export function htmlToBlocks(html: string, schema: Schema): JSONContent[] | null {
  if (!html || !STRUCTURED.test(html)) return null;
  try {
    const dom = new window.DOMParser().parseFromString(html, 'text/html').body;
    const doc = PMDOMParser.fromSchema(schema).parse(dom);
    const blocks: JSONContent[] = [];
    doc.forEach((n) => blocks.push(sanitizeContent(n.toJSON() as JSONContent)));
    return blocks.some((b) => b.content?.length || b.type !== 'paragraph') ? blocks : null;
  } catch {
    return null;
  }
}
