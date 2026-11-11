// Sidebar preferences that live on this device: panel widths, collapsed tree
// nodes, favourite (pinned) pages, recently opened pages, the Notes selection
// (notebook / section, and the last page opened in each section), the page sort
// and the last place visited in each rail view, per workspace.
import { create } from 'zustand';
import { platform } from '../../platform/index.ts';

const KEY = 'noteapp.sidebar';
export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 420;
export const SIDEBAR_DEFAULT = 216;
export const PAGES_MIN = 160;
export const PAGES_MAX = 380;
export const PAGES_DEFAULT = 200;
const RECENT_MAX = 8;

export type RailView = 'notes' | 'tasks' | 'calendar';
export type PageSort = 'manual' | 'title' | 'updated';

interface Persisted {
  width: number;
  collapsed: Record<string, boolean>;
  favorites: Record<string, string[]>; // wsId → page ids
  recent: Record<string, string[]>; // wsId → page ids, newest first
  /** Width of the Notes view's second panel (the pages of the selected section). */
  pagesWidth: number;
  /** wsId → the notebook and section last selected in the Notes panel. */
  notesSel: Record<string, { nb?: string; sec?: string }>;
  /** notebook id → last selected section; section id → last opened page. */
  lastSection: Record<string, string>;
  lastPage: Record<string, string>;
  pageSort: PageSort;
  /** wsId → view → last path (with query) visited in that view. */
  lastLoc: Record<string, Partial<Record<RailView, string>>>;
  /** Bumped when the default widths change, so saved widths from older defaults reset once. */
  layout?: number;
}

const LAYOUT = 2;

function load(): Persisted {
  const base: Persisted = {
    width: SIDEBAR_DEFAULT,
    collapsed: {},
    favorites: {},
    recent: {},
    pagesWidth: PAGES_DEFAULT,
    notesSel: {},
    lastSection: {},
    lastPage: {},
    pageSort: 'manual',
    lastLoc: {},
    layout: LAYOUT,
  };
  try {
    const v = JSON.parse(platform.kv.get(KEY) ?? 'null');
    if (v && typeof v === 'object') {
      // Older installs saved the wider v0.2.0 defaults; start them on the narrower ones.
      if ((v.layout ?? 1) < LAYOUT) Object.assign(v, { width: SIDEBAR_DEFAULT, pagesWidth: PAGES_DEFAULT, layout: LAYOUT });
      return { ...base, ...v };
    }
    // Migrate the older collapsed-only key.
    const old = JSON.parse(platform.kv.get('noteapp.collapsed') ?? 'null');
    if (old && typeof old === 'object') base.collapsed = old;
  } catch {
    /* fall through */
  }
  return base;
}

export const useSidebar = create<Persisted>(load);

let saveTimer: ReturnType<typeof setTimeout> | undefined;
const save = () => {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  platform.kv.set(KEY, JSON.stringify(useSidebar.getState()));
};
// Leaving or reloading within the debounce must not lose the last change (recent pages, selection).
if (typeof window !== 'undefined') window.addEventListener('pagehide', () => saveTimer !== undefined && save());
useSidebar.subscribe(() => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 150);
});

const clamp = (w: number, min = SIDEBAR_MIN, max = SIDEBAR_MAX) => Math.round(Math.min(max, Math.max(min, w)));

export const sidebar = {
  setWidth: (w: number) => useSidebar.setState({ width: clamp(w) }),
  resetWidth: () => useSidebar.setState({ width: SIDEBAR_DEFAULT }),
  setPagesWidth: (w: number) => useSidebar.setState({ pagesWidth: clamp(w, PAGES_MIN, PAGES_MAX) }),
  resetPagesWidth: () => useSidebar.setState({ pagesWidth: PAGES_DEFAULT }),
  setPageSort: (pageSort: PageSort) => useSidebar.setState({ pageSort }),
  /** Remember the Notes selection (and, per notebook / section, the last child chosen). */
  selectNotes: (wsId: string, nb: string | undefined, sec: string | undefined, page?: string) =>
    useSidebar.setState((s) => {
      const cur = s.notesSel[wsId];
      const same = cur?.nb === nb && cur?.sec === sec && (!nb || !sec || s.lastSection[nb] === sec) && (!sec || !page || s.lastPage[sec] === page);
      if (same) return s;
      return {
        notesSel: { ...s.notesSel, [wsId]: { nb, sec } },
        lastSection: nb && sec ? { ...s.lastSection, [nb]: sec } : s.lastSection,
        lastPage: sec && page ? { ...s.lastPage, [sec]: page } : s.lastPage,
      };
    }),
  rememberLocation: (wsId: string, view: RailView, path: string) =>
    useSidebar.setState((s) => {
      if (s.lastLoc[wsId]?.[view] === path) return s;
      return { lastLoc: { ...s.lastLoc, [wsId]: { ...s.lastLoc[wsId], [view]: path } } };
    }),
  toggleNode: (id: string, value?: boolean) =>
    useSidebar.setState((s) => ({ collapsed: { ...s.collapsed, [id]: value ?? !s.collapsed[id] } })),
  isFavorite: (wsId: string, pageId: string) => (useSidebar.getState().favorites[wsId] ?? []).includes(pageId),
  toggleFavorite: (wsId: string, pageId: string) =>
    useSidebar.setState((s) => {
      const list = s.favorites[wsId] ?? [];
      const next = list.includes(pageId) ? list.filter((x) => x !== pageId) : [...list, pageId];
      return { favorites: { ...s.favorites, [wsId]: next } };
    }),
  moveFavorite: (wsId: string, pageId: string, index: number) =>
    useSidebar.setState((s) => {
      const list = (s.favorites[wsId] ?? []).filter((x) => x !== pageId);
      list.splice(Math.max(0, Math.min(index, list.length)), 0, pageId);
      return { favorites: { ...s.favorites, [wsId]: list } };
    }),
  visit: (wsId: string, pageId: string) =>
    useSidebar.setState((s) => {
      const list = s.recent[wsId] ?? [];
      if (list[0] === pageId) return s;
      return { recent: { ...s.recent, [wsId]: [pageId, ...list.filter((x) => x !== pageId)].slice(0, RECENT_MAX) } };
    }),
};
