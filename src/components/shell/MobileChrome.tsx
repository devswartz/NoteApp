// Phone layout chrome: a contextual top bar, the bottom tab bar with a floating
// quick-add button, and edge-swipe for the notes drawer (the sidebar).
// Rendered by AppShell only at phone widths (useIsMobile).
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { BookOpen, CalendarDays, ChevronLeft, ListChecks, Lock, Menu, Plus, Search } from 'lucide-react';
import { useLockedNotes } from '../../lib/lockedNotes.ts';
import { ui, useStore } from '../../store.ts';
import { NotificationBell } from '../sharing/NotificationBell.tsx';
import { viewOf, viewTarget } from './navState.ts';
import type { RailView } from './sidebarState.ts';
import { useOpenedView } from '../../pages/tasks/savedViews.ts';

const VIEW_TITLES: Record<string, string> = {
  today: 'Today',
  my: 'My Tasks',
  upcoming: 'Upcoming',
  team: 'Team',
  all: 'All tasks',
  calendar: 'Calendar',
};

/** Title for the current screen: the view name, the page title, or the workspace. */
function useScreenTitle(): string {
  const { pathname } = useLocation();
  const ws = useStore((s) => s.workspaces.find((w) => w.id === s.wsId));
  const pageId = pathname.match(/\/p\/([^/?#]+)/)?.[1];
  const pageTitle = useStore((s) => (pageId ? s.tree.pages.find((p) => p.id === pageId)?.title : undefined));
  const view = pathname.match(/\/tasks\/([^/?#]+)/)?.[1];
  const saved = useOpenedView(); // a saved view of All Tasks is titled by its name
  if (view === 'all' && saved) return saved.name;
  if (view) return VIEW_TITLES[view] ?? 'Tasks';
  if (pageId) return pageTitle || 'Untitled';
  if (pathname.endsWith('/notes')) return 'Notes';
  if (pathname.endsWith('/settings')) return 'Settings';
  if (pathname.endsWith('/activity')) return 'Activity';
  if (pathname.endsWith('/trash')) return 'Trash';
  return ws?.name ?? '';
}

/**
 * True while the screen's own large heading (its first h1, or a page's title)
 * is on screen. The top bar then shows just the workspace, and takes over the
 * screen title once the heading scrolls away (iOS "large title" style).
 */
function useHeadingVisible(): boolean {
  // The query matters too: Settings sections are ?s=<id> on the same path.
  const { pathname, search } = useLocation();
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    let io: IntersectionObserver | undefined;
    let tries = 0;
    let timer: number | undefined;
    const attach = () => {
      const el = document.querySelector('.route h1, .route .page-title');
      if (!el) {
        setVisible(false);
        if (tries++ < 20) timer = window.setTimeout(attach, 100); // the screen may still be loading
        return;
      }
      io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: '-56px 0px 0px 0px' });
      io.observe(el);
    };
    attach();
    return () => {
      window.clearTimeout(timer);
      io?.disconnect();
    };
  }, [pathname, search]);
  return visible;
}

/** On a page, Back goes up to the page's section in the Notes drill-down (notebook → section → page). */
function usePageBack(): string | null {
  const { pathname } = useLocation();
  const wsId = useStore((s) => s.wsId);
  const pageId = pathname.match(/\/p\/([^/?#]+)/)?.[1];
  const section = useStore((s) => {
    const page = pageId ? s.tree.pages.find((p) => p.id === pageId) : undefined;
    return page ? s.tree.sections.find((x) => x.id === page.sectionId) : undefined;
  });
  if (!pageId || !wsId) return null;
  return section ? `/w/${wsId}/notes?nb=${section.notebookId}&sec=${section.id}` : `/w/${wsId}/notes`;
}

export function MobileTopBar() {
  const title = useScreenTitle();
  const ws = useStore((s) => s.workspaces.find((w) => w.id === s.wsId));
  const headingVisible = useHeadingVisible();
  const { pathname } = useLocation();
  const lockedId = pathname.match(/\/p\/([^/?#]+)/)?.[1];
  const pageLocked = useStore((s) => !!lockedId && !!s.tree.pages.find((p) => p.id === lockedId)?.locked);
  const unlocked = useLockedNotes((s) => s.unlocked);
  // A locked page's lock screen: the bar names the page, with a lock (its heading is the lock screen's own).
  const lockScreen = pageLocked && !unlocked;
  const showTitle = (lockScreen || !headingVisible) && ws && title !== ws.name;
  const back = usePageBack();
  const navigate = useNavigate();
  return (
    <header className="mobile-top">
      {back ? (
        <button className="btn-ghost icon-btn touch" onClick={() => navigate(back)} aria-label="Back">
          <ChevronLeft size={22} />
        </button>
      ) : (
        <button className="btn-ghost icon-btn touch" onClick={() => ui.setSidebar(true)} aria-label="Open menu">
          <Menu size={21} />
        </button>
      )}
      <div className={`mobile-title ${showTitle ? 'has-title' : ''}`}>
        {showTitle ? (
          <>
            <span className="truncate mobile-title-main">
              {lockScreen && <Lock size={14} aria-label="Locked" className="mobile-title-lock" />}
              {title}
            </span>
            <span className="mobile-subtitle truncate">{ws!.name}</span>
          </>
        ) : (
          <span className="truncate">{ws?.name}</span>
        )}
      </div>
      <div className="mobile-top-actions">
        <NotificationBell size={20} />
        <button className="btn-ghost icon-btn touch" onClick={ui.openPalette} aria-label="Search">
          <Search size={20} />
        </button>
      </div>
    </header>
  );
}

export function MobileTabBar({ wsId }: { wsId: string }) {
  const canEdit = useStore((s) => s.workspaces.find((w) => w.id === s.wsId)?.role !== 'viewer');
  const paletteOpen = useStore((s) => s.paletteOpen);
  const { pathname } = useLocation();
  // Not on Settings, and not on a page: there the task sheet and inline tasks sit where the button would.
  const showFab = canEdit && !pathname.endsWith('/settings') && !/\/p\//.test(pathname);
  // The same views as the desktop rail; each reopens where you last were in it.
  const current = viewOf(pathname);
  const tab = (view: RailView, icon: React.ReactNode, label: string) => (
    <Link
      to={view === 'notes' && current === 'notes' ? `/w/${wsId}/notes` : viewTarget(wsId, view)}
      className={`tab ${current === view && !paletteOpen ? 'is-active' : ''}`}
      aria-current={current === view ? 'page' : undefined}
    >
      {icon}
      <span>{label}</span>
    </Link>
  );
  return (
    <nav className="tabbar" aria-label="Primary">
      {tab('notes', <BookOpen size={22} />, 'Notes')}
      {tab('tasks', <ListChecks size={22} />, 'Tasks')}
      {tab('calendar', <CalendarDays size={22} />, 'Calendar')}
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
