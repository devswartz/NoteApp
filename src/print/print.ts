// Printing notes: the open page (Ctrl/Cmd+P, the ribbon's Print, the page menu) or a whole
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
import { clearPrintRoot, imagesReady, mountPrintRoot, renderPrintPage, type PrintContext, type PrintPageInput } from './printDoc.ts';

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

/** A job is being prepared or its dialog is open. */
let busy = false;
/**
 * The print root holds a job the app prepared that the system hasn't printed yet. Native
 * dialogs (macOS, iOS, Android) return before printing and may never fire afterprint, so a
 * beforeprint they cause must not replace the job with the open page.
 */
let prepared = false;

async function run(pages: PrintPageInput[], title: string, ctx: PrintContext) {
  installPrintHandlers();
  const root = mountPrintRoot(pages.map((p) => renderPrintPage(p, ctx)));
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
    const meta = useStore.getState().tree.pages.find((p) => p.id === page.pageId);
    const doc = snapshotDoc(page.doc);
    await run([{ pageId: page.pageId, doc, heights: measuredHeights(page.doc) }], meta?.title ?? '', context());
  } catch (e) {
    errorToast(e);
  } finally {
    busy = false;
  }
  return true;
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
  if (busy) return;
  const { tree } = useStore.getState();
  const section = tree.sections.find((s) => s.id === sectionId);
  const ids = sectionPageIds(sectionId);
  if (!section) return;
  if (!ids.length) {
    toast('This section has no pages to print');
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
      section.name,
      context(extraTasks),
    );
  } catch (e) {
    errorToast(e);
  } finally {
    busy = false;
  }
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
    mountPrintRoot([renderPrintPage({ pageId: page.pageId, doc: snapshotDoc(page.doc), heights: measuredHeights(page.doc) }, context())]);
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
