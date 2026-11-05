import { useEffect, useRef } from 'react';
import { NavLink, Navigate, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Menu, Sun, Inbox, Search, Plus, BookOpen, PanelLeftOpen } from 'lucide-react';
import { post } from '../api.ts';
import { errorToast, selectWorkspace, toast, ui, useStore } from '../store.ts';
import { Sidebar } from './Sidebar.tsx';
import { TaskDetail } from './TaskDetail.tsx';
import { QuickAdd } from './QuickAdd.tsx';
import { CommandPalette } from './CommandPalette.tsx';
import { OfflineBanner, ShortcutsHelp } from './Overlays.tsx';
import { MOD, useIsMobile } from './ui.tsx';
import { platform } from '../platform/index.ts';

/** Layout for everything inside a workspace. */
export function AppShell() {
  const { wsId } = useParams() as { wsId: string };
  const workspaces = useStore((s) => s.workspaces);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const isMobile = useIsMobile();
  const valid = workspaces.some((w) => w.id === wsId);

  useEffect(() => {
    if (valid) selectWorkspace(wsId).catch(errorToast);
  }, [wsId, valid]);

  useGlobalShortcuts(wsId);
  useReminders();

  if (!valid) return <Navigate to="/" replace />;

  return (
    <div className={`app ${sidebarOpen ? 'sidebar-open' : 'sidebar-closed'} ${isMobile ? 'is-mobile' : ''}`}>
      <OfflineBanner />
      {isMobile && sidebarOpen && <div className="drawer-backdrop" onClick={() => ui.setSidebar(false)} />}
      <Sidebar />
      <main className="main">
        {isMobile ? <MobileTopBar /> : !sidebarOpen && (
          <button className="btn-ghost icon-btn sidebar-reveal" onClick={ui.toggleSidebar} title={`Show sidebar (${MOD}\\)`}>
            <PanelLeftOpen size={18} />
          </button>
        )}
        <Outlet />
      </main>
      {isMobile && <MobileTabBar wsId={wsId} />}
      <TaskDetail />
      <QuickAdd />
      <CommandPalette />
      <ShortcutsHelp />
    </div>
  );
}

function MobileTopBar() {
  const ws = useStore((s) => s.workspaces.find((w) => w.id === s.wsId));
  return (
    <div className="mobile-top">
      <button className="btn-ghost icon-btn" onClick={() => ui.setSidebar(true)} aria-label="Open menu">
        <Menu size={20} />
      </button>
      <span className="truncate">{ws?.name}</span>
      <button className="btn-ghost icon-btn" onClick={ui.openPalette} aria-label="Search">
        <Search size={19} />
      </button>
    </div>
  );
}

function MobileTabBar({ wsId }: { wsId: string }) {
  const canEdit = useStore((s) => s.workspaces.find((w) => w.id === s.wsId)?.role !== 'viewer');
  const tab = (to: string, icon: React.ReactNode, label: string) => (
    <NavLink to={to} className={({ isActive }) => `tab ${isActive ? 'is-active' : ''}`}>
      {icon}
      <span>{label}</span>
    </NavLink>
  );
  return (
    <nav className="tabbar" aria-label="Primary">
      {tab(`/w/${wsId}/notes`, <BookOpen size={21} />, 'Notes')}
      {tab(`/w/${wsId}/tasks/today`, <Sun size={21} />, 'Today')}
      {canEdit && (
        <button className="tab tab-add" onClick={() => ui.openQuickAdd()} aria-label="Add task">
          <Plus size={24} />
        </button>
      )}
      {tab(`/w/${wsId}/tasks/my`, <Inbox size={21} />, 'My Tasks')}
      <button className="tab" onClick={ui.openPalette}>
        <Search size={21} />
        <span>Search</span>
      </button>
    </nav>
  );
}

function isTyping(e: KeyboardEvent) {
  const el = e.target as HTMLElement;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

function useGlobalShortcuts(wsId: string) {
  const navigate = useNavigate();
  const location = useLocation();
  const pending = useRef<{ key: string; at: number } | null>(null);
  const locRef = useRef(location.pathname);
  locRef.current = location.pathname;

  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        const s = useStore.getState();
        if (s.paletteOpen) ui.closePalette();
        else ui.openPalette();
        return;
      }
      if (mod && e.key === '\\') {
        e.preventDefault();
        ui.toggleSidebar();
        return;
      }
      if (mod || e.altKey || isTyping(e)) return;
      const s = useStore.getState();
      if (s.paletteOpen || s.quickAdd || s.taskDetailId || s.shortcutsOpen) return;

      const k = e.key.toLowerCase();
      if (pending.current?.key === 'g' && Date.now() - pending.current.at < 1200) {
        pending.current = null;
        const dest: Record<string, string> = {
          t: 'tasks/today',
          m: 'tasks/my',
          u: 'tasks/upcoming',
          e: 'tasks/team',
          a: 'tasks/all',
          c: 'tasks/calendar',
          d: 'tasks/completed',
          s: 'settings',
          n: 'notes',
        };
        if (dest[k]) {
          e.preventDefault();
          navigate(`/w/${wsId}/${dest[k]}`);
        }
        return;
      }
      if (k === 'g') {
        pending.current = { key: 'g', at: Date.now() };
        return;
      }
      const canEdit = s.workspaces.find((w) => w.id === wsId)?.role !== 'viewer';
      if (k === 'q' && canEdit) {
        e.preventDefault();
        const m = locRef.current.match(/\/p\/([^/]+)/);
        ui.openQuickAdd(m ? { pageId: m[1] } : {});
      } else if (e.key === '?') {
        e.preventDefault();
        ui.setShortcuts(true);
      } else if (k === 'n' && canEdit) {
        // New page in the current page's section (or the first section).
        e.preventDefault();
        const m = locRef.current.match(/\/p\/([^/]+)/);
        const current = m ? s.tree.pages.find((p) => p.id === m[1]) : undefined;
        const sectionId = current?.sectionId ?? s.tree.sections[0]?.id;
        if (!sectionId) return toast('Create a notebook first');
        try {
          const { id } = await post<{ id: string }>(`/sections/${sectionId}/pages`, { title: '' });
          navigate(`/w/${wsId}/p/${id}`);
        } catch (err) {
          errorToast(err);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [wsId, navigate]);
}

/**
 * Client-side reminders: fires a notification (or in-app toast) when a
 * reminder time passes while the app is open. Server push is a future step.
 */
function useReminders() {
  useEffect(() => {
    const KEY = 'noteapp.firedReminders';
    const check = () => {
      const { tasks, user } = useStore.getState();
      if (!user) return;
      let fired: Record<string, string> = {};
      try {
        fired = JSON.parse(platform.kv.get(KEY) ?? '{}');
      } catch {
        /* ignore */
      }
      const now = Date.now();
      for (const t of Object.values(tasks)) {
        if (t.status !== 'open' || !t.reminderAt) continue;
        if (t.assigneeId ? t.assigneeId !== user.id : t.createdBy !== user.id) continue;
        const at = Date.parse(t.reminderAt);
        // Only fire reminders that came due in the last hour, once each.
        if (at > now || now - at > 3600_000 || fired[t.id] === t.reminderAt) continue;
        fired[t.id] = t.reminderAt;
        if (platform.notifications.permission() === 'granted' && platform.isHidden()) {
          platform.notifications.show('Reminder', { body: t.title, tag: t.id, onClick: () => ui.openTask(t.id) });
        } else {
          toast(`⏰ ${t.title}`, { action: { label: 'Open', run: () => ui.openTask(t.id) } });
        }
      }
      platform.kv.set(KEY, JSON.stringify(fired));
    };
    const iv = setInterval(check, 30_000);
    check();
    return () => clearInterval(iv);
  }, []);
}
