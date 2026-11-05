// Global UI toggles (palette, quick add, task detail, sidebar, shortcuts help)
// and the appearance preference (light / dark / system).
import { create } from 'zustand';
import { set, type QuickAddDefaults } from './state.ts';
import { platform } from '../platform/index.ts';

export const ui = {
  openPalette: () => set({ paletteOpen: true }),
  closePalette: () => set({ paletteOpen: false }),
  openQuickAdd: (d: QuickAddDefaults = {}) => set({ quickAdd: d }),
  closeQuickAdd: () => set({ quickAdd: null }),
  openTask: (id: string | null) => set({ taskDetailId: id }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebar: (open: boolean) => set({ sidebarOpen: open }),
  setShortcuts: (open: boolean) => set({ shortcutsOpen: open }),
};

// ───────────── Theme ─────────────

export type ThemePref = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const THEME_KEY = 'noteapp.theme';

function readPref(): ThemePref {
  try {
    const v = platform.kv.get(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

const darkQuery = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
const resolve = (pref: ThemePref): ResolvedTheme => (pref === 'system' ? (darkQuery?.matches ? 'dark' : 'light') : pref);

interface ThemeState {
  pref: ThemePref;
  resolved: ResolvedTheme;
}

export const useTheme = create<ThemeState>(() => {
  const pref = readPref();
  return { pref, resolved: resolve(pref) };
});

function applyTheme(theme: ResolvedTheme, animate: boolean) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (animate) {
    root.classList.add('theme-switching');
    window.setTimeout(() => root.classList.remove('theme-switching'), 250);
  }
  root.dataset.theme = theme;
  // Keep the browser / OS chrome (status bar, title bar) in step with the app.
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim() || (theme === 'dark' ? '#18181b' : '#ffffff');
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((m) => {
    m.removeAttribute('media');
    m.content = bg;
  });
}

export function setThemePref(pref: ThemePref) {
  platform.kv.set(THEME_KEY, pref);
  const resolved = resolve(pref);
  useTheme.setState({ pref, resolved });
  applyTheme(resolved, true);
}

/** Cycles light → dark → system (for the command palette / shortcut). */
export function cycleTheme() {
  const order: ThemePref[] = ['light', 'dark', 'system'];
  setThemePref(order[(order.indexOf(useTheme.getState().pref) + 1) % order.length]);
}

// Apply as soon as the store module loads (before the first render) and follow
// the OS setting while the preference is "system".
applyTheme(useTheme.getState().resolved, false);
darkQuery?.addEventListener('change', () => {
  const { pref } = useTheme.getState();
  if (pref !== 'system') return;
  const resolved = resolve(pref);
  useTheme.setState({ resolved });
  applyTheme(resolved, true);
});
