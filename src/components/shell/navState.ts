// Where each rail view opens and the Notes selection (notebook → section → page)
// derived from the route. The pure rules are in navRules.ts.
import { useLocation, useSearchParams } from 'react-router-dom';
import { useStore } from '../../store.ts';
import { useSidebar, type RailView } from './sidebarState.ts';
import { byPos } from './treePosition.ts';
import { childSections, resolveSelection, VIEW_HOME, type NotesSelection } from './navRules.ts';

export * from './navRules.ts';

/** Where a rail button goes: the last place visited in that view, or its home. */
export function viewTarget(wsId: string, view: RailView): string {
  const last = useSidebar.getState().lastLoc[wsId]?.[view];
  return last && last.startsWith(`/w/${wsId}/`) ? last : `/w/${wsId}/${VIEW_HOME[view]}`;
}

/**
 * The Notes selection: from the open page when there is one, else from
 * /notes?nb=&sec=, else the last selection on this device, else the first
 * notebook and its first section.
 */
export function useNotesSelection(wsId: string): NotesSelection {
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const tree = useStore((s) => s.tree);
  const me = useStore((s) => s.user?.id ?? '');
  const stored = useSidebar((s) => s.notesSel[wsId]);
  const lastSection = useSidebar((s) => s.lastSection);
  return resolveSelection(tree, me, pathname, params, stored, lastSection);
}

/** Where opening a section goes: its last opened page, else its first page, else the empty-section screen. */
export function sectionTarget(wsId: string, sectionId: string): string {
  const { tree } = useStore.getState();
  const pages = tree.pages.filter((p) => p.sectionId === sectionId).sort(byPos);
  const last = useSidebar.getState().lastPage[sectionId];
  const page = pages.find((p) => p.id === last) ?? pages[0];
  return page ? `/w/${wsId}/p/${page.id}` : `/w/${wsId}/notes?sec=${encodeURIComponent(sectionId)}`;
}

/** Where opening a notebook goes: its last section (see sectionTarget), else the notebook screen. */
export function notebookTarget(wsId: string, notebookId: string): string {
  const { tree } = useStore.getState();
  const last = useSidebar.getState().lastSection[notebookId];
  const sec = tree.sections.find((s) => s.id === last && s.notebookId === notebookId) ?? childSections(tree, notebookId, null)[0];
  return sec ? sectionTarget(wsId, sec.id) : `/w/${wsId}/notes?nb=${encodeURIComponent(notebookId)}`;
}
