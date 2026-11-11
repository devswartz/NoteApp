// Pure navigation rules (no store or router imports, so they're unit-tested in
// tests/navState.test.ts): which rail view a route belongs to, the section tree
// order, and how the Notes selection is resolved.
import type { Notebook, Section, Tree } from '../../../shared/types.ts';
import type { RailView } from './sidebarState.ts';
import { byPos } from './treePosition.ts';

/** The rail view for a path inside a workspace, or null (Settings, Activity). */
export function viewOf(pathname: string): RailView | null {
  if (/\/p\/[^/]+/.test(pathname) || /\/notes\/?$/.test(pathname)) return 'notes';
  if (/\/tasks\/calendar\/?$/.test(pathname)) return 'calendar';
  if (/\/tasks\//.test(pathname)) return 'tasks';
  return null;
}

export const VIEW_HOME: Record<RailView, string> = { notes: 'notes', tasks: 'tasks/today', calendar: 'tasks/calendar' };

/** Track 3 adds `Section.parentId` (nested sections); read it optionally so this works before and after. */
export const parentOf = (s: Section): string | null => (s as Section & { parentId?: string | null }).parentId ?? null;

/** Sections directly under `parent` (null = the notebook's top level), in order. */
export function childSections(tree: Tree, notebookId: string, parent: string | null): Section[] {
  return tree.sections.filter((s) => s.notebookId === notebookId && parentOf(s) === parent).sort(byPos);
}

/** Notebooks in picker order: mine first, then the ones others made (shared with me). */
export function splitNotebooks(notebooks: Notebook[], me: string) {
  const sorted = [...notebooks].sort(byPos);
  return { mine: sorted.filter((n) => n.createdBy === me), shared: sorted.filter((n) => n.createdBy !== me) };
}

export interface NotesSelection {
  notebookId: string | null;
  sectionId: string | null;
  pageId: string | null;
}

export function resolveSelection(
  tree: Tree,
  me: string,
  pathname: string,
  params: URLSearchParams,
  stored: { nb?: string; sec?: string } | undefined,
  lastSection: Record<string, string>,
): NotesSelection {
  const pageId = pathname.match(/\/p\/([^/?#]+)/)?.[1] ?? null;
  const secById = new Map(tree.sections.map((s) => [s.id, s]));
  const nbIds = new Set(tree.notebooks.map((n) => n.id));
  const page = pageId ? tree.pages.find((p) => p.id === pageId) : undefined;
  if (page && secById.has(page.sectionId)) return { notebookId: secById.get(page.sectionId)!.notebookId, sectionId: page.sectionId, pageId };

  const onNotes = /\/notes\/?$/.test(pathname);
  const qSec = onNotes ? params.get('sec') : null;
  const qNb = onNotes ? params.get('nb') : null;
  if (qSec && secById.has(qSec)) return { notebookId: secById.get(qSec)!.notebookId, sectionId: qSec, pageId };
  let nb = qNb && nbIds.has(qNb) ? qNb : null;
  if (!nb && !qNb) {
    if (stored?.sec && secById.has(stored.sec)) return { notebookId: secById.get(stored.sec)!.notebookId, sectionId: stored.sec, pageId };
    nb = stored?.nb && nbIds.has(stored.nb) ? stored.nb : null;
    if (!nb) {
      const { mine, shared } = splitNotebooks(tree.notebooks, me);
      nb = (mine[0] ?? shared[0])?.id ?? null;
    }
  }
  if (!nb) return { notebookId: null, sectionId: null, pageId };
  // A notebook alone (the phone's notebook screen) doesn't pick a section.
  if (qNb) return { notebookId: nb, sectionId: null, pageId };
  const remembered = lastSection[nb];
  const sec = remembered && secById.get(remembered)?.notebookId === nb ? remembered : (childSections(tree, nb, null)[0]?.id ?? null);
  return { notebookId: nb, sectionId: sec, pageId };
}

