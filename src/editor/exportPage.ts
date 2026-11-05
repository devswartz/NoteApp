// Export a page as Markdown or PDF (the browser's print → "Save as PDF", using the
// print stylesheet in editor.css), and import Markdown into a page.
import type { Editor } from '@tiptap/core';
import { patch } from '../api.ts';
import { errorToast, toast, useStore } from '../store.ts';
import { platform } from '../platform/index.ts';
import { fileName, liftInlineImages, splitTitle } from './markdownUtils.ts';
import { sanitizeContent } from './urls.ts';

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

export async function exportMarkdown(editor: Editor, pageId: string) {
  const meta = useStore.getState().tree.pages.find((p) => p.id === pageId);
  const title = meta?.title || 'Untitled';
  await saveFile(fileName(title, 'md'), pageMarkdown(editor, title, meta?.icon ?? null), 'text/markdown;charset=utf-8');
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

/** Pick .md files and append them to the page (the first file's "# Title" names an untitled page). */
export async function importMarkdown(editor: Editor, pageId: string) {
  const files = await platform.pickFiles({ accept: '.md,.markdown,.txt,text/markdown,text/plain', multiple: true });
  for (const [i, file] of files.entries()) {
    try {
      const { title, body } = splitTitle(await file.text());
      const meta = useStore.getState().tree.pages.find((p) => p.id === pageId);
      if (i === 0 && title && !meta?.title) {
        useStore.setState((s) => ({ tree: { ...s.tree, pages: s.tree.pages.map((p) => (p.id === pageId ? { ...p, title } : p)) } }));
        patch(`/pages/${pageId}`, { title }).catch(errorToast);
      }
      const md = i === 0 && title && !meta?.title ? body : title ? `## ${title}\n\n${body}` : body;
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
