// Export a page as Markdown or PDF (the browser's print → "Save as PDF", using the
// print stylesheet in editor.css), and import Markdown into a page.
import type { Editor } from '@tiptap/core';
import { patch } from '../api.ts';
import { errorToast, toast, useStore } from '../store.ts';
import { platform } from '../platform/index.ts';
import { fileName, liftInlineImages, splitTitle } from './markdownUtils.ts';
import { sanitizeContent } from './urls.ts';
import { canvasMarkdownBody, withHeadlessEditor, type CanvasHandle } from './canvasDoc.ts';

/**
 * Hand a generated file to the user. The platform adapter has no "save file" yet,
 * so this is the one place that uses a download link; shells can add
 * `platform.saveFile` and it is picked up here.
 */
export async function saveFile(name: string, text: string, type: string) {
  const p = platform as unknown as { saveFile?: (name: string, data: Blob) => Promise<void> };
  const blob = new Blob([text], { type });
  if (p.saveFile) return p.saveFile(name, blob);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function pageMarkdown(editor: Editor, title: string, icon: string | null) {
  const heading = `# ${icon ? `${icon} ` : ''}${title || 'Untitled'}`;
  // Serialise a sanitised copy: an unsafe link or image never reaches the exported file.
  const json = sanitizeContent(editor.getJSON());
  const body = editor.markdown ? editor.markdown.serialize(json) : editor.getMarkdown();
  return `${heading}\n\n${body.trim()}\n`;
}

/** A canvas page as Markdown: its boxes in reading order, one after the other. */
export function canvasMarkdown(canvas: CanvasHandle, title: string, icon: string | null) {
  const heading = `# ${icon ? `${icon} ` : ''}${title || 'Untitled'}`;
  return `${heading}\n\n${canvasMarkdownBody(canvas.pageId, canvas.doc)}\n`;
}

/** Export the page (a document editor's content, or a canvas's boxes) as a .md file. */
export async function exportMarkdown(source: Editor | CanvasHandle, pageId: string) {
  const meta = useStore.getState().tree.pages.find((p) => p.id === pageId);
  const title = meta?.title || 'Untitled';
  const md = 'addBox' in source ? canvasMarkdown(source, title, meta?.icon ?? null) : pageMarkdown(source, title, meta?.icon ?? null);
  await saveFile(fileName(title, 'md'), md, 'text/markdown;charset=utf-8');
}

/** Print the page alone (the print stylesheet hides the app around it); "Save as PDF" in the dialog. */
export function printPage(title: string) {
  const prev = document.title;
  document.title = title || 'Untitled'; // becomes the PDF's default file name
  const restore = () => {
    document.title = prev;
    window.removeEventListener('afterprint', restore);
  };
  window.addEventListener('afterprint', restore);
  window.print();
}

/**
 * Pick .md files and append them to the page (the first file's "# Title" names an untitled page).
 * On a canvas, each file becomes a new text box under the others.
 */
export async function importMarkdown(target: Editor | CanvasHandle, pageId: string) {
  await importMarkdownFiles(target, pageId, await pickMarkdownFiles());
}

export const pickMarkdownFiles = () => platform.pickFiles({ accept: '.md,.markdown,.txt,text/markdown,text/plain', multiple: true });

/**
 * Markdown files picked before their page existed (the Notes ribbon's Import: pick, create a
 * page, open it); the page imports them once its canvas is ready (PageView).
 */
let pending: { pageId: string; files: File[] } | null = null;
export const setPendingImport = (pageId: string, files: File[]) => void (pending = { pageId, files });
export function takePendingImport(pageId: string): File[] | null {
  if (pending?.pageId !== pageId) return null;
  const { files } = pending;
  pending = null;
  return files;
}

export async function importMarkdownFiles(target: Editor | CanvasHandle, pageId: string, files: File[]) {
  for (const [i, file] of files.entries()) {
    try {
      const { title, body } = splitTitle(await file.text());
      const meta = useStore.getState().tree.pages.find((p) => p.id === pageId);
      if (i === 0 && title && !meta?.title) {
        useStore.setState((s) => ({ tree: { ...s.tree, pages: s.tree.pages.map((p) => (p.id === pageId ? { ...p, title } : p)) } }));
        patch(`/pages/${pageId}`, { title }).catch(errorToast);
      }
      const md = i === 0 && title && !meta?.title ? body : title ? `## ${title}\n\n${body}` : body;
      if ('addBox' in target) {
        const doc = withHeadlessEditor(pageId, (e) => (e.markdown ? liftInlineImages(sanitizeContent(e.markdown.parse(md))) : null));
        if (!doc) return;
        target.addBox(doc.content ?? []);
        toast(`Imported ${file.name}`);
        continue;
      }
      const editor = target;
      if (editor.isDestroyed || !editor.markdown) return;
      // Parse first, then drop javascript:/data: links and images before anything enters the document.
      const doc = liftInlineImages(sanitizeContent(editor.markdown.parse(md)));
      const empty = editor.isEmpty;
      const chain = editor.chain().focus('end');
      if (empty) chain.setContent(doc);
      else chain.insertContentAt(editor.state.doc.content.size, doc.content ?? []);
      chain.run();
      toast(`Imported ${file.name}`);
    } catch (e) {
      errorToast(e);
    }
  }
}
