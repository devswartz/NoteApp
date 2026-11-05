// Drag-and-drop for the sidebar tree (pointer devices; touch uses "Move to…").
//   page     → before/after a page, or into a section
//   section  → before/after a section (any notebook), or into a notebook
//   notebook → before/after a notebook
//   favorite → reorder favourites; a page dropped on the Favourites heading pins it
// Moves are optimistic: the local tree is updated at once, then the server's
// /move endpoint (server/routes/tree.ts, pages.ts) is called; a `tree` event
// or, on error, a reload brings the canonical order back.
import { create } from 'zustand';
import type { DragEvent } from 'react';
import { post } from '../../api.ts';
import { errorToast, loadTree, useStore } from '../../store.ts';
import type { Tree } from '../../../shared/types.ts';
import { sidebar } from './sidebarState.ts';
import { byPos, positionAt } from './treePosition.ts';

export type DragKind = 'page' | 'section' | 'notebook' | 'favorite';
export type Where = 'before' | 'after' | 'inside';

interface DndState {
  drag: { kind: DragKind; id: string } | null;
  drop: { kind: DragKind | 'favorites'; id: string; where: Where } | null;
}

export const useDnd = create<DndState>(() => ({ drag: null, drop: null }));

const MIME = 'application/x-noteapp-tree';

export function dragProps(kind: DragKind, id: string, enabled: boolean) {
  if (!enabled) return {};
  return {
    draggable: true,
    onDragStart: (e: DragEvent) => {
      e.stopPropagation();
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData(MIME, `${kind}:${id}`);
      if (kind === 'page' || kind === 'favorite') e.dataTransfer.setData('application/x-page', id);
      useDnd.setState({ drag: { kind, id } });
    },
    onDragEnd: () => useDnd.setState({ drag: null, drop: null }),
  };
}

/** Which drops a target of `kind` accepts from the current drag, and where. */
function accepts(target: DragKind | 'favorites', drag: DragKind): Where[] {
  if (target === 'page') return drag === 'page' ? ['before', 'after'] : [];
  if (target === 'section') return drag === 'section' ? ['before', 'after', 'inside'] : drag === 'page' ? ['inside'] : [];
  if (target === 'notebook') return drag === 'notebook' ? ['before', 'after', 'inside'] : drag === 'section' ? ['inside'] : [];
  if (target === 'favorite') return drag === 'favorite' ? ['before', 'after'] : drag === 'page' ? ['inside'] : [];
  return drag === 'page' ? ['inside'] : []; // favorites heading
}

export function dropProps(kind: DragKind | 'favorites', id: string, onDrop: (where: Where) => void) {
  return {
    onDragOver: (e: DragEvent) => {
      const drag = useDnd.getState().drag;
      if (!drag || drag.id === id) return;
      const ok = accepts(kind, drag.kind);
      if (!ok.length) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const y = (e.clientY - r.top) / r.height;
      // Same-kind targets split into thirds (before / inside / after) when "inside" is allowed.
      let where: Where;
      if (ok.length === 1) where = ok[0];
      else if (!ok.includes('inside')) where = y < 0.5 ? 'before' : 'after';
      else where = y < 0.3 ? 'before' : y > 0.7 ? 'after' : 'inside';
      if (where === 'inside' && drag.kind === kind && kind === 'notebook') where = y < 0.5 ? 'before' : 'after';
      if (where === 'inside' && drag.kind === kind && kind === 'section') where = y < 0.5 ? 'before' : 'after';
      const cur = useDnd.getState().drop;
      if (cur?.id !== id || cur.where !== where || cur.kind !== kind) useDnd.setState({ drop: { kind, id, where } });
    },
    onDragLeave: (e: DragEvent) => {
      if ((e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) return;
      if (useDnd.getState().drop?.id === id) useDnd.setState({ drop: null });
    },
    onDrop: (e: DragEvent) => {
      const drop = useDnd.getState().drop;
      if (!drop || drop.id !== id) return;
      e.preventDefault();
      e.stopPropagation();
      onDrop(drop.where);
      useDnd.setState({ drag: null, drop: null });
    },
  };
}

/** Class for a row's drop indicator. */
export const dropClass = (id: string, drop: DndState['drop']) =>
  drop?.id === id ? (drop.where === 'inside' ? 'is-drop' : drop.where === 'before' ? 'is-drop-before' : 'is-drop-after') : '';

// ───────────── Moves ─────────────

function patchTree(fn: (t: Tree) => Tree) {
  useStore.setState((s) => ({ tree: fn(s.tree) }));
}

async function send(path: string, body: object) {
  try {
    await post(path, body);
  } catch (e) {
    errorToast(e);
    void loadTree();
  }
}

/** Index of the drop among `sibs` (already without the dragged item). */
const indexFor = (sibs: { id: string }[], targetId: string, where: Where) => {
  const i = sibs.findIndex((s) => s.id === targetId);
  return i < 0 ? sibs.length : where === 'after' ? i + 1 : i;
};

export function movePage(pageId: string, sectionId: string, targetId: string | null, where: Where) {
  const { tree } = useStore.getState();
  const sibs = tree.pages.filter((p) => p.sectionId === sectionId && p.id !== pageId).sort(byPos);
  const index = targetId && where !== 'inside' ? indexFor(sibs, targetId, where) : sibs.length;
  const position = positionAt(sibs, index);
  patchTree((t) => ({ ...t, pages: t.pages.map((p) => (p.id === pageId ? { ...p, sectionId, position } : p)) }));
  sidebar.toggleNode(sectionId, false);
  return send(`/pages/${pageId}/move`, { sectionId, index });
}

export function moveSection(sectionId: string, notebookId: string, targetId: string | null, where: Where) {
  const { tree } = useStore.getState();
  const sibs = tree.sections.filter((s) => s.notebookId === notebookId && s.id !== sectionId).sort(byPos);
  const index = targetId && where !== 'inside' ? indexFor(sibs, targetId, where) : sibs.length;
  const position = positionAt(sibs, index);
  patchTree((t) => ({ ...t, sections: t.sections.map((s) => (s.id === sectionId ? { ...s, notebookId, position } : s)) }));
  sidebar.toggleNode(notebookId, false);
  return send(`/sections/${sectionId}/move`, { notebookId, index });
}

export function moveNotebook(notebookId: string, targetId: string, where: Where) {
  const { tree } = useStore.getState();
  const sibs = tree.notebooks.filter((n) => n.id !== notebookId).sort(byPos);
  const index = indexFor(sibs, targetId, where);
  const position = positionAt(sibs, index);
  patchTree((t) => ({ ...t, notebooks: t.notebooks.map((n) => (n.id === notebookId ? { ...n, position } : n)) }));
  return send(`/notebooks/${notebookId}/move`, { index });
}

export { byPos, positionAt };
