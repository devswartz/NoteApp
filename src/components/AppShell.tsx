import { useEffect } from 'react';
import { NavLink, Navigate, Outlet, useParams } from 'react-router-dom';
import { Menu, Sun, Inbox, Search, Plus, BookOpen, PanelLeftOpen } from 'lucide-react';
import { errorToast, selectWorkspace, toast, ui, useStore } from '../store.ts';
import { useShortcutListener } from '../hooks/useShortcuts.ts';
import { useShellCommands } from './shell/commands.tsx';
import { DialogHost } from './shell/dialogs.tsx';
import { Sidebar } from './Sidebar.tsx';
import { TaskDetail } from './TaskDetail.tsx';
import { QuickAdd } from './QuickAdd.tsx';
import { CommandPalette } from './CommandPalette.tsx';
import { OfflineBanner, ShortcutsHelp } from './Overlays.tsx';
import { IconButton, MOD, useIsMobile } from './ui.tsx';
import { platform } from '../platform/index.ts';

/** True while a modal-like overlay is open; plain shortcuts pause then. */
const overlayOpen = () => {
  const s = useStore.getState();
  return s.paletteOpen || !!s.quickAdd || !!s.taskDetailId || s.shortcutsOpen;
};

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

  useShellCommands(wsId);
  useShortcutListener(overlayOpen);
  useReminders();

  if (!valid) return <Navigate to="/" replace />;

  return (
    <div className={`app ${sidebarOpen ? 'sidebar-open' : 'sidebar-closed'} ${isMobile ? 'is-mobile' : ''}`}>
      <OfflineBanner />
      {isMobile && sidebarOpen && <div className="drawer-backdrop" onClick={() => ui.setSidebar(false)} />}
      <Sidebar />
      <main className="main">
        {isMobile ? <MobileTopBar /> : !sidebarOpen && (
          <IconButton label="Show sidebar" shortcut={`${MOD}\\`} className="sidebar-reveal" onClick={ui.toggleSidebar}>
            <PanelLeftOpen size={18} />
          </IconButton>
        )}
        <Outlet />
      </main>
      {isMobile && <MobileTabBar wsId={wsId} />}
      <TaskDetail />
      <QuickAdd />
      <CommandPalette />
      <ShortcutsHelp />
      <DialogHost />
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
