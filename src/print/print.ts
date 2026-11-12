// Printing notes: the open page (Ctrl/Cmd+P, the ribbon's Print, the page menu), just the selection on it
// (selected text, or boxes picked with Ctrl/Cmd+click: "Print selection") or a whole
// section (its context menu). Pages are rendered into #print-root (./printDoc.ts), which is
// the only thing on paper while a print job is prepared (src/styles/print.css), then the
// platform's native print dialog opens (platform.print: window.print on the web and Windows,
// WKWebView's print operation on macOS, UIPrintInteractionController on iOS, PrintManager on
// Android). Every system dialog offers "Save as PDF".
import * as Y from 'yjs';
import { get } from '../api.ts';
import { errorToast, toast, useStore } from '../store.ts';
import { platform } from '../platform/index.ts';
import { sectionsInOrder, sectionDescendants } from '../../shared/sections.ts';
import { boxGeoms, isContentField } from '../../shared/pageDoc.ts';
import type { Task } from '../../shared/types.ts';
import { useRibbon } from '../editor/ribbonState.ts';
import { useBoxSelection, selectionEditor } from '../editor/boxSelection.ts';
import { linePicks } from '../editor/linePicks.ts';
import { useShared } from '../components/sharing/sharedPages.ts';
import { selectionBlocks } from './selectionContent.ts';
import { chooseDialog } from '../components/shell/dialogs.tsx';
import { clearPrintRoot, imagesReady, mountPrintRoot, renderContents, renderPrintPage, type PrintContext, type PrintPageInput } from './printDoc.ts';
import { contentsOf, type ContentsTarget } from './contents.ts';

const PAGE_COLOUR_KEY = 'noteapp.printPageColour';

/** "Print page colour": off by default (a per-device choice). */
export function printPageColour(): boolean {
  try {
    return platform.kv.get(PAGE_COLOUR_KEY) === '1';
  } catch {
    return false;
  }
}
export function setPrintPageColour(on: boolean) {
  try {
    platform.kv.set(PAGE_COLOUR_KEY, on ? '1' : '0');
  } catch {
    // storage unavailable: lasts for this visit only
  }
}

function context(extraTasks: Record<string, Task> = {}): PrintContext {
  const s = useStore.getState();
  return { tree: s.tree, tasks: { ...extraTasks, ...s.tasks }, members: s.members, pageColour: printPageColour() };
}

/** Canvas heights of the open page's boxes, so side-by-side boxes are recognised as on screen. */
function measuredHeights(doc: Y.Doc): Record<string, number> {
  const out: Record<string, number> = {};
  for (const b of boxGeoms(doc)) {
    const node = document.querySelector<HTMLElement>(`.canvas-box[data-box-id="${CSS.escape(b.id)}"]`);
    if (node?.offsetHeight) out[b.id] = node.offsetHeight;
  }
  return out;
}

/** A copy of a live doc, so rendering never touches the collaborative one. */
function snapshotDoc(doc: Y.Doc): Y.Doc {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return copy;
}

/**
 * The open page's title: from the workspace's page list, else from the pages shared with me (a page from another
 * workspace isn't in the list), else what is in the title field right now. Never empty for a page that has a name.
 */
export function openPageTitle(pageId: string): string {
  const own = useStore.getState().tree.pages.find((p) => p.id === pageId)?.title;
  if (own) return own;
  const shared = useShared.getState().pages.find((p) => p.id === pageId)?.title;
  if (shared) return shared;
  return document.querySelector<HTMLTextAreaElement>('textarea.page-title')?.value.trim() ?? '';
}

/** A job is being prepared or its dialog is open. */
let busy = false;
/**
 * The print root holds a job the app prepared that the system hasn't printed yet. Native
 * dialogs (macOS, iOS, Android) return before printing and may never fire afterprint, so a
 * beforeprint they cause must not replace the job with the open page.
 */
let prepared = false;

async function run(pages: (PrintPageInput | HTMLElement)[], title: string, ctx: PrintContext) {
  installPrintHandlers();
  const root = mountPrintRoot(pages.map((p) => (p instanceof HTMLElement ? p : renderPrintPage(p, ctx))));
  prepared = true;
  await imagesReady(root);
  const prev = document.title;
  document.title = title || 'Untitled'; // the PDF's default file name
  try {
    await platform.print(document.title);
  } finally {
    // The web dialog is modal (print() returns once it closes); native dialogs may return
    // early, so the title comes back a little later.
    setTimeout(() => (document.title = prev), 1000);
  }
}

/** The open page's id and doc (PageView registers it for the ribbon). */
export const openPage = () => useRibbon.getState().page;

/** Print the open page. Returns false when no page is open. */
export async function printCurrentPage(): Promise<boolean> {
  const page = openPage();
  if (!page) return false;
  if (busy) return true;
  busy = true;
  try {
    const title = openPageTitle(page.pageId);
    const doc = snapshotDoc(page.doc);
    await run([{ pageId: page.pageId, doc, title, heights: measuredHeights(page.doc) }], title, context());
  } catch (e) {
    errorToast(e);
  } finally {
    busy = false;
  }
  return true;
}

/**
 * What "Print selection" prints on the open page: the picked boxes (Ctrl/Cmd+click), else the
 * selected text of the box (or document) being edited. Null when nothing is selected.
 */
export function pageSelection(): Pick<PrintPageInput, 'boxIds' | 'blocks' | 'boxBlocks'> | null {
  const page = openPage();
  if (!page) return null;
  const picked = useBoxSelection.getState();
  const boxes = picked.pageId === page.pageId ? picked.ids : [];
  const lines = linePicks.blocks(page.pageId);
  // Picked boxes and picked lines print together, in reading order; a box picked whole prints whole.
  if (boxes.length || Object.keys(lines).length) {
    const onlyLines = Object.fromEntries(Object.entries(lines).filter(([id]) => !boxes.includes(id)));
    return { boxIds: [...new Set([...boxes, ...Object.keys(onlyLines)])], ...(Object.keys(onlyLines).length ? { boxBlocks: onlyLines } : {}) };
  }
  const ed = selectionEditor(page.pageId);
  if (!ed) return null;
  const blocks = selectionBlocks(ed.state.selection);
  return blocks.length ? { blocks } : null;
}

/**
 * Print only the selection (`sel`, or the current one): the page's title on top, then the
 * picked boxes in reading order or the selected content. Rendered by the app (a webview's own
 * "Selection" print option is unreliable). Returns false when there is nothing to print.
 */
export async function printSelection(sel = pageSelection()): Promise<boolean> {
  const page = openPage();
  if (!page || !sel) return false;
  if (busy) return true;
  busy = true;
  try {
    const title = openPageTitle(page.pageId);
    const doc = snapshotDoc(page.doc);
    await run([{ pageId: page.pageId, doc, title, heights: measuredHeights(page.doc), ...sel }], title, context());
  } catch (e) {
    errorToast(e);
  } finally {
    busy = false;
  }
  return true;
}

/**
 * Ctrl/Cmd+P, the ribbon's Print and the page menu: with something selected, ask whether to
 * print the selection or the whole page; otherwise print the page.
 */
export async function printWithChoice(): Promise<boolean> {
  const sel = pageSelection();
  if (!sel) return printCurrentPage();
  const pick = await chooseDialog({
    title: 'Print',
    message: sel.boxBlocks ? 'Print the selected lines or the whole page?' : sel.boxIds ? `Print the ${sel.boxIds.length === 1 ? 'selected box' : `${sel.boxIds.length} selected boxes`} or the whole page?` : 'Print the selected text or the whole page?',
    confirmLabel: 'Print selection',
    cancelLabel: 'Whole page',
  });
  if (pick === null) return true;
  return pick ? printSelection(sel) : printCurrentPage();
}

function decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The pages of a section and its subsections, in tree order (the section's own pages first, then each subsection's). */
export function sectionPageIds(sectionId: string): string[] {
  const { tree } = useStore.getState();
  const section = tree.sections.find((s) => s.id === sectionId);
  if (!section) return [];
  const inside = sectionDescendants(tree, sectionId);
  const order = sectionsInOrder(tree, section.notebookId)
    .map((x) => x.section.id)
    .filter((id) => inside.has(id));
  return order.flatMap((sid) =>
    tree.pages
      .filter((p) => p.sectionId === sid)
      .sort((a, b) => a.position - b.position)
      .map((p) => p.id),
  );
}

/** How many pages are loaded at once when printing a section. */
const PARALLEL = 4;

/**
 * Print every page of a section (and its subsections, in tree order), each starting on a new
 * sheet with its title. Pages are read as they are now (GET /pages/:id/doc), without opening
 * a collab session for each; a progress toast counts them on large sections.
 */
export async function printSection(sectionId: string) {
  const section = useStore.getState().tree.sections.find((s) => s.id === sectionId);
  if (section) await printPages(sectionPageIds(sectionId), section.name, 'This section has no pages to print');
}

/** The pages of a whole notebook, in tree order: each section's own pages, then its subsections'. */
export function notebookPageIds(notebookId: string): string[] {
  const { tree } = useStore.getState();
  return sectionsInOrder(tree, notebookId).flatMap(({ section }) =>
    tree.pages
      .filter((p) => p.sectionId === section.id)
      .sort((a, b) => a.position - b.position)
      .map((p) => p.id),
  );
}

/** Print every page of a notebook (all its sections), each starting on a new sheet. */
export async function printNotebook(notebookId: string) {
  const nb = useStore.getState().tree.notebooks.find((n) => n.id === notebookId);
  if (nb) await printPages(notebookPageIds(notebookId), nb.name, 'This notebook has no pages to print');
}

/** Print these pages in order (`name` titles the print job). */
async function printPages(ids: string[], name: string, empty: string) {
  if (busy) return;
  if (!ids.length) {
    toast(empty);
    return;
  }
  busy = true;
  try {
    const docs = new Map<string, Y.Doc>();
    const extraTasks: Record<string, Task> = {};
    let done = 0;
    const report = () => ids.length > 5 && toast(`Preparing to print… ${done} of ${ids.length} pages`);
    report();
    for (let i = 0; i < ids.length; i += PARALLEL) {
      await Promise.all(
        ids.slice(i, i + PARALLEL).map(async (id) => {
          const live = openPage();
          const doc = live?.pageId === id ? snapshotDoc(live.doc) : new Y.Doc();
          if (live?.pageId !== id) Y.applyUpdate(doc, decode((await get<{ ydoc: string }>(`/pages/${id}/doc`)).ydoc));
          docs.set(id, doc);
          // Tasks on pages shared from outside the workspace aren't in the store: fetch those.
          if (hasUnknownTask(doc, useStore.getState().tasks)) for (const t of await get<Task[]>(`/pages/${id}/tasks`).catch(() => [] as Task[])) extraTasks[t.id] = t;
          done++;
        }),
      );
      if (i + PARALLEL < ids.length) report();
    }
    await run(
      ids.map((id) => ({ pageId: id, doc: docs.get(id)! })),
      name,
      context(extraTasks),
    );
  } catch (e) {
    errorToast(e);
  } finally {
    busy = false;
  }
}

/**
 * Print the contents of a section or notebook: its subsections and pages as an indented list, titles only,
 * on one sheet. Nothing is fetched: the hierarchy is in the app already.
 */
export async function printContents(target: ContentsTarget): Promise<void> {
  if (busy) return;
  const node = contentsOf(useStore.getState().tree, target);
  if (!node) return;
  if (!node.children.length) {
    toast(`This ${node.kind} has nothing to list yet`);
    return;
  }
  busy = true;
  try {
    await run([renderContents(node)], `${node.title} contents`, context());
  } catch (e) {
    errorToast(e);
  } finally {
    busy = false;
  }
}

/**
 * "Print…" on a section or notebook's menu: ask whether to print every page or just a contents list.
 * Dismissing the question prints nothing.
 */
export async function printWithContentsChoice(target: ContentsTarget): Promise<void> {
  const { tree } = useStore.getState();
  const name = target.kind === 'section' ? tree.sections.find((s) => s.id === target.id)?.name : tree.notebooks.find((n) => n.id === target.id)?.name;
  const pick = await chooseDialog({
    title: `Print ${target.kind}`,
    message: `Print every page of “${name ?? target.kind}”, or just a contents list of its ${target.kind === 'notebook' ? 'sections' : 'subsections'} and pages?`,
    confirmLabel: 'All pages',
    cancelLabel: 'Contents only',
  });
  if (pick === null) return;
  if (!pick) return printContents(target);
  return target.kind === 'section' ? printSection(target.id) : printNotebook(target.id);
}

/** Does the doc reference a task the store doesn't have? */
function hasUnknownTask(doc: Y.Doc, known: Record<string, Task>): boolean {
  let found = false;
  const walk = (n: Y.XmlElement | Y.XmlFragment) => {
    for (const c of n.toArray()) {
      if (found || !(c instanceof Y.XmlElement)) continue;
      if (c.nodeName === 'taskRef') {
        const id = c.getAttribute('taskId');
        if (id && !known[id]) found = true;
      } else walk(c);
    }
  };
  for (const name of doc.share.keys()) if (isContentField(name)) walk(doc.getXmlFragment(name));
  return found;
}

/**
 * Printing from outside the app (the browser's own menu, a print shortcut the app didn't see):
 * prepare the open page just in time, so paper never shows the app's chrome. A job the app
 * started itself is already prepared; anywhere else, a leftover job is cleared so the view
 * prints as usual. Installed once, for the life of the app.
 */
let installed = false;
export function installPrintHandlers() {
  if (installed) return;
  installed = true;
  const before = () => {
    if (busy || prepared) return;
    const page = openPage();
    if (!page) {
      clearPrintRoot();
      return;
    }
    mountPrintRoot([renderPrintPage({ pageId: page.pageId, doc: snapshotDoc(page.doc), title: openPageTitle(page.pageId), heights: measuredHeights(page.doc) }, context())]);
  };
  // The job has gone to the printer: the next print starts afresh. (While the app's own
  // job is still in print(), the root stays: some browsers lay out again after afterprint.)
  const after = () => {
    prepared = false;
    if (!busy) clearPrintRoot();
  };
  window.addEventListener('beforeprint', before);
  window.addEventListener('afterprint', after);
}
