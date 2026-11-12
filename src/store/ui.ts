// Global UI toggles (palette, quick add, task detail, sidebar, shortcuts help)
// and the appearance preferences (theme: light / dark / hybrid / system; accent colour).
import { create } from 'zustand';
import { set, SIDEBAR_KEY, useStore, type QuickAddDefaults } from './state.ts';
import { platform } from '../platform/index.ts';

export const ui = {
  openPalette: () => set({ paletteOpen: true }),
  closePalette: () => set({ paletteOpen: false }),
  openQuickAdd: (d: QuickAddDefaults = {}) => set({ quickAdd: d }),
  closeQuickAdd: () => set({ quickAdd: null }),
  openTask: (id: string | null) => set({ taskDetailId: id }),
  toggleSidebar: () => setSidebarOpen(!useStore.getState().sidebarOpen),
  setSidebar: (open: boolean) => setSidebarOpen(open),
  setShortcuts: (open: boolean) => set({ shortcutsOpen: open }),
};

function setSidebarOpen(open: boolean) {
  set({ sidebarOpen: open });
  // Phones use the panels as a drawer that closes after each tap; only bigger screens remember the choice.
  if (typeof window !== 'undefined' && window.innerWidth > 760) platform.kv.set(SIDEBAR_KEY, open ? '1' : '0');
}

// ───────────── Theme ─────────────

/** Hybrid: dark app chrome around a light note page (see "Hybrid" in src/styles.css). */
export type ThemePref = 'light' | 'dark' | 'hybrid' | 'system';
export type ResolvedTheme = 'light' | 'dark' | 'hybrid';

const THEME_KEY = 'noteapp.theme';

function readPref(): ThemePref {
  try {
    const v = platform.kv.get(THEME_KEY);
    return v === 'light' || v === 'dark' || v === 'hybrid' ? v : 'system';
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
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim() || (theme === 'light' ? '#ffffff' : '#18181b');
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

/**
 * Re-read the stored preference. The store first reads it when the module
 * loads, which can be before initPlatform() swaps in a shell's storage, so the
 * app shell calls this once after start-up.
 */
export function syncThemePref() {
  syncAccent();
  const pref = readPref();
  if (pref === useTheme.getState().pref) return;
  const resolved = resolve(pref);
  useTheme.setState({ pref, resolved });
  applyTheme(resolved, false);
}

/** Cycles light → dark → hybrid → system (for the command palette / shortcut). */
export function cycleTheme() {
  const order: ThemePref[] = ['light', 'dark', 'hybrid', 'system'];
  setThemePref(order[(order.indexOf(useTheme.getState().pref) + 1) % order.length]);
}

// ───────────── Accent colour ─────────────
// Stored per device like the theme and set as <html data-accent> before first paint
// (public/theme-init.js); the colours for each theme are in src/styles/accents.css.

export const ACCENTS = [
  { id: 'blue', label: 'Blue', swatch: '#4f46e5' },
  { id: 'purple', label: 'Purple', swatch: '#9333ea' },
  { id: 'teal', label: 'Teal', swatch: '#0d9488' },
  { id: 'green', label: 'Green', swatch: '#16a34a' },
  { id: 'orange', label: 'Orange', swatch: '#ea580c' },
  { id: 'red', label: 'Red', swatch: '#dc2626' },
  { id: 'pink', label: 'Pink', swatch: '#db2777' },
  { id: 'graphite', label: 'Graphite', swatch: '#52525b' },
] as const;
export type Accent = (typeof ACCENTS)[number]['id'];
export const DEFAULT_ACCENT: Accent = 'blue';
const ACCENT_KEY = 'noteapp.accent';

function readAccent(): Accent {
  try {
    const v = platform.kv.get(ACCENT_KEY);
    return ACCENTS.some((a) => a.id === v) ? (v as Accent) : DEFAULT_ACCENT;
  } catch {
    return DEFAULT_ACCENT;
  }
}

export const useAccent = create<{ accent: Accent }>(() => ({ accent: readAccent() }));

function applyAccent(accent: Accent) {
  if (typeof document === 'undefined') return;
  // The default is the base tokens, so it needs no attribute.
  if (accent === DEFAULT_ACCENT) delete document.documentElement.dataset.accent;
  else document.documentElement.dataset.accent = accent;
}

export function setAccent(accent: Accent) {
  try {
    platform.kv.set(ACCENT_KEY, accent);
  } catch {
    // storage unavailable: the choice lasts for this visit only
  }
  useAccent.setState({ accent });
  applyAccent(accent);
}

/** Re-read after initPlatform() swaps in a shell's storage (see syncThemePref). */
export function syncAccent() {
  const accent = readAccent();
  useAccent.setState({ accent });
  applyAccent(accent);
}

applyAccent(useAccent.getState().accent);

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

// ───────────── Page side panel (tasks / comments) ─────────────

export type PagePanel = 'tasks' | 'comments' | null;
const PAGE_PANEL_KEY = 'noteapp.pagePanel';

function readPagePanel(): PagePanel {
  try {
    const v = platform.kv.get(PAGE_PANEL_KEY);
    return v === 'tasks' || v === 'comments' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Which page panel is open on this device (#99). Closed unless the person opened
 * it; closing it is remembered on every page. Phones never restore it on page
 * open (PageView), so a note always opens as just the note.
 */
export const usePagePanel = create<{ panel: PagePanel }>(() => ({ panel: readPagePanel() }));

export function setPagePanel(panel: PagePanel) {
  try {
    platform.kv.set(PAGE_PANEL_KEY, panel ?? '');
  } catch {
    // storage unavailable: the choice lasts for this visit only
  }
  usePagePanel.setState({ panel });
}

/** Re-read after initPlatform() swaps in a shell's storage (see syncThemePref). */
export function syncPagePanel() {
  usePagePanel.setState({ panel: readPagePanel() });
}
