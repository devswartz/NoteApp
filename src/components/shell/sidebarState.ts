// Sidebar preferences that live on this device: width, collapsed tree nodes,
// favourite (pinned) pages and recently opened pages, per workspace.
import { create } from 'zustand';
import { platform } from '../../platform/index.ts';

const KEY = 'noteapp.sidebar';
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 420;
export const SIDEBAR_DEFAULT = 264;
const RECENT_MAX = 8;

interface Persisted {
  width: number;
  collapsed: Record<string, boolean>;
  favorites: Record<string, string[]>; // wsId → page ids
  recent: Record<string, string[]>; // wsId → page ids, newest first
}

function load(): Persisted {
  const base: Persisted = { width: SIDEBAR_DEFAULT, collapsed: {}, favorites: {}, recent: {} };
  try {
    const v = JSON.parse(platform.kv.get(KEY) ?? 'null');
    if (v && typeof v === 'object') return { ...base, ...v };
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
useSidebar.subscribe((s) => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const { width, collapsed, favorites, recent } = s;
    platform.kv.set(KEY, JSON.stringify({ width, collapsed, favorites, recent }));
  }, 150);
});

const clamp = (w: number) => Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w)));

export const sidebar = {
  setWidth: (w: number) => useSidebar.setState({ width: clamp(w) }),
  resetWidth: () => useSidebar.setState({ width: SIDEBAR_DEFAULT }),
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
