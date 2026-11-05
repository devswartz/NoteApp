// Phone layout chrome: a contextual top bar, the bottom tab bar with a floating
// quick-add button, and edge-swipe for the notes drawer (the sidebar).
// Rendered by AppShell only at phone widths (useIsMobile).
import { useEffect, useRef } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { BookOpen, Inbox, Menu, Plus, Search, Sun } from 'lucide-react';
import { ui, useStore } from '../../store.ts';

const VIEW_TITLES: Record<string, string> = {
  today: 'Today',
  my: 'My Tasks',
  upcoming: 'Upcoming',
  team: 'Team',
  all: 'All Tasks',
  calendar: 'Calendar',
  completed: 'Completed',
};

/** Title for the current screen: the view name, the page title, or the workspace. */
function useScreenTitle(): string {
  const { pathname } = useLocation();
  const ws = useStore((s) => s.workspaces.find((w) => w.id === s.wsId));
  const pageId = pathname.match(/\/p\/([^/?#]+)/)?.[1];
  const pageTitle = useStore((s) => (pageId ? s.tree.pages.find((p) => p.id === pageId)?.title : undefined));
  const view = pathname.match(/\/tasks\/([^/?#]+)/)?.[1];
  if (view) return VIEW_TITLES[view] ?? 'Tasks';
  if (pageId) return pageTitle || 'Untitled';
  if (pathname.endsWith('/notes')) return 'Notes';
  if (pathname.endsWith('/settings')) return 'Settings';
  return ws?.name ?? '';
}

export function MobileTopBar() {
  const title = useScreenTitle();
  const ws = useStore((s) => s.workspaces.find((w) => w.id === s.wsId));
  return (
    <header className="mobile-top">
      <button className="btn-ghost icon-btn touch" onClick={() => ui.setSidebar(true)} aria-label="Open menu">
        <Menu size={21} />
      </button>
      <div className="mobile-title">
        <span className="truncate">{title}</span>
        {ws && title !== ws.name && <span className="mobile-subtitle truncate">{ws.name}</span>}
      </div>
      <button className="btn-ghost icon-btn touch" onClick={ui.openPalette} aria-label="Search">
        <Search size={20} />
      </button>
    </header>
  );
}

export function MobileTabBar({ wsId }: { wsId: string }) {
  const canEdit = useStore((s) => s.workspaces.find((w) => w.id === s.wsId)?.role !== 'viewer');
  const paletteOpen = useStore((s) => s.paletteOpen);
  const { pathname } = useLocation();
  const showFab = canEdit && !pathname.endsWith('/settings');
  const tab = (to: string, icon: React.ReactNode, label: string) => (
    <NavLink to={to} className={({ isActive }) => `tab ${isActive ? 'is-active' : ''}`}>
      {icon}
      <span>{label}</span>
    </NavLink>
  );
  return (
    <nav className="tabbar" aria-label="Primary">
      {tab(`/w/${wsId}/tasks/today`, <Sun size={22} />, 'Today')}
      {tab(`/w/${wsId}/tasks/my`, <Inbox size={22} />, 'My Tasks')}
      {tab(`/w/${wsId}/notes`, <BookOpen size={22} />, 'Notes')}
      <button className={`tab ${paletteOpen ? 'is-active' : ''}`} onClick={ui.openPalette}>
        <Search size={22} />
        <span>Search</span>
      </button>
      {showFab && (
        <button className="fab" onClick={() => ui.openQuickAdd()} aria-label="Add task">
          <Plus size={26} strokeWidth={2.25} />
        </button>
      )}
    </nav>
  );
}

const EDGE = 24; // px from the left edge where a swipe opens the drawer
const OPEN_AT = 0.35; // fraction of the drawer width

/**
 * Swipe from the left edge to pull the drawer open; swipe it left to close.
 * The drawer follows the finger and settles open or closed on release.
 */
export function useDrawerSwipe(enabled: boolean) {
  const state = useRef<{ x: number; y: number; open: boolean; w: number; dx: number; locked: boolean | null } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const drawer = () => document.querySelector<HTMLElement>('.sidebar');
    const backdrop = () => document.querySelector<HTMLElement>('.drawer-backdrop');

    const start = (e: TouchEvent) => {
      const t = e.touches[0];
      const open = useStore.getState().sidebarOpen;
      const el = drawer();
      if (!el || e.touches.length > 1) return;
      if (!open && t.clientX > EDGE) return;
      if (open && !(e.target as Element).closest('.sidebar, .drawer-backdrop')) return;
      state.current = { x: t.clientX, y: t.clientY, open, w: el.offsetWidth, dx: 0, locked: null };
    };
    const move = (e: TouchEvent) => {
      const s = state.current;
      if (!s) return;
      const t = e.touches[0];
      const dx = t.clientX - s.x;
      const dy = t.clientY - s.y;
      if (s.locked === null) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        s.locked = Math.abs(dx) > Math.abs(dy);
        if (!s.locked) return void (state.current = null); // vertical scroll wins
      }
      s.dx = dx;
      const offset = s.open ? Math.min(0, dx) : Math.min(0, -s.w + Math.max(0, dx));
      const el = drawer();
      if (el) {
        el.style.transition = 'none';
        el.style.transform = `translateX(${offset}px)`;
      }
      const b = backdrop();
      if (b) b.style.opacity = String(1 + offset / s.w);
    };
    const end = () => {
      const s = state.current;
      state.current = null;
      const el = drawer();
      if (el) {
        el.style.transition = '';
        el.style.transform = '';
      }
      const b = backdrop();
      if (b) b.style.opacity = '';
      if (!s?.locked) return;
      if (!s.open && s.dx > s.w * OPEN_AT) ui.setSidebar(true);
      else if (s.open && s.dx < -s.w * OPEN_AT) ui.setSidebar(false);
    };
    document.addEventListener('touchstart', start, { passive: true });
    document.addEventListener('touchmove', move, { passive: true });
    document.addEventListener('touchend', end);
    document.addEventListener('touchcancel', end);
    return () => {
      document.removeEventListener('touchstart', start);
      document.removeEventListener('touchmove', move);
      document.removeEventListener('touchend', end);
      document.removeEventListener('touchcancel', end);
    };
  }, [enabled]);
}
