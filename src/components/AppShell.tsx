import { useEffect } from 'react';
import { Navigate, Outlet, useLocation, useParams } from 'react-router-dom';
import { PanelLeftOpen } from 'lucide-react';
import { errorToast, selectWorkspace, toast, ui, useStore } from '../store.ts';
import { useShortcutListener } from '../hooks/useShortcuts.ts';
import { useShellCommands } from './shell/commands.tsx';
import { DialogHost } from './shell/dialogs.tsx';
import { MobileTabBar, MobileTopBar, useDrawerSwipe } from './shell/MobileChrome.tsx';
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
  const location = useLocation();
  const valid = workspaces.some((w) => w.id === wsId);

  useEffect(() => {
    if (valid) selectWorkspace(wsId).catch(errorToast);
  }, [wsId, valid]);

  useShellCommands(wsId);
  useShortcutListener(overlayOpen);
  useReminders();
  useDrawerSwipe(isMobile);

  if (!valid) return <Navigate to="/" replace />;
  // Fade between screens (tasks, notes, settings), not between pages of the same kind.
  const routeKey = location.pathname.split('/')[3] ?? '';

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
        <div className="route" key={routeKey}>
          <Outlet />
        </div>
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
