// The left rail: the three views (Notes, Tasks, Calendar) at the top; search,
// notifications, the workspace switcher and the user menu at the bottom.
// Each view button reopens the last place visited in that view (navState.ts).
import { useNavigate } from 'react-router-dom';
import { Activity, BookOpen, CalendarDays, ChevronDown, Contrast, Keyboard, ListChecks, LogOut, Monitor, Moon, PanelLeftClose, PanelLeftOpen, Plus, Search, Settings, Sun, Trash2 } from 'lucide-react';
import { post } from '../../api.ts';
import { errorToast, loadWorkspaces, signOut, ui, useStore } from '../../store.ts';
import { setThemePref, useTheme, type ThemePref } from '../../store/ui.ts';
import { Avatar, Dropdown, MenuItem, MenuLabel, MenuSeparator, MOD } from '../ui.tsx';
import { NotificationBell } from '../sharing/NotificationBell.tsx';
import { promptDialog } from './dialogs.tsx';
import { viewTarget } from './navState.ts';
import type { RailView } from './sidebarState.ts';

const VIEWS: { id: RailView; label: string; icon: typeof BookOpen }[] = [
  { id: 'notes', label: 'Notes', icon: BookOpen },
  { id: 'tasks', label: 'Tasks', icon: ListChecks },
  { id: 'calendar', label: 'Calendar', icon: CalendarDays },
];

export function Rail({ wsId, view }: { wsId: string; view: RailView | null }) {
  const navigate = useNavigate();
  const open = useStore((s) => s.sidebarOpen);
  return (
    <nav className="rail" aria-label="Views" onKeyDown={railKeys}>
      <div className="rail-views">
        {VIEWS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className={`rail-btn ${view === id ? 'is-active' : ''}`}
            aria-current={view === id ? 'page' : undefined}
            data-view={id}
            onClick={() => {
              navigate(viewTarget(wsId, id));
              if (!useStore.getState().sidebarOpen) ui.setSidebar(true);
            }}
          >
            <Icon size={20} />
            <span className="rail-label">{label}</span>
          </button>
        ))}
      </div>
      <div className="rail-foot">
        <button
          type="button"
          className="rail-btn rail-icon"
          aria-label={open ? 'Hide sidebar' : 'Show sidebar'}
          title={`${open ? 'Hide' : 'Show'} sidebar (${MOD}\)`}
          aria-expanded={open}
          onClick={ui.toggleSidebar}
        >
          {open ? <PanelLeftClose size={19} /> : <PanelLeftOpen size={19} />}
        </button>
        <button type="button" className="rail-btn rail-icon" aria-label="Search" title={`Search (${MOD}K)`} onClick={ui.openPalette}>
          <Search size={19} />
        </button>
        <div className="rail-bell">
          <NotificationBell size={19} />
        </div>
        <WorkspaceSwitcher compact />
        <UserMenu wsId={wsId} />
      </div>
    </nav>
  );
}

/** Up/Down move between the rail's buttons. */
function railKeys(e: React.KeyboardEvent<HTMLElement>) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('button')];
  const i = items.indexOf(e.target as HTMLElement);
  if (i < 0) return;
  e.preventDefault();
  items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
}

export function WorkspaceSwitcher({ compact }: { compact?: boolean }) {
  const workspaces = useStore((s) => s.workspaces);
  const wsId = useStore((s) => s.wsId);
  const current = workspaces.find((w) => w.id === wsId);
  const navigate = useNavigate();
  return (
    <Dropdown
      buttonClass={compact ? 'rail-btn rail-icon ws-switch ws-switch-compact' : 'ws-switch'}
      title="Switch workspace"
      placement={compact ? 'right-end' : undefined}
      trigger={
        compact ? (
          <>
            <span className="ws-logo">{current?.name[0]?.toUpperCase() ?? '·'}</span>
            <span className="sr-only">{current?.name}</span>
          </>
        ) : (
          <>
            <span className="ws-logo">{current?.name[0]?.toUpperCase() ?? '·'}</span>
            <span className="truncate">{current?.name ?? 'Workspace'}</span>
            <ChevronDown size={14} className="muted" />
          </>
        )
      }
    >
      {(close) => (
        <div className="menu" role="menu" style={{ minWidth: 240 }}>
          {workspaces.map((w) => (
            <MenuItem key={w.id} icon={<span className="ws-logo sm">{w.name[0]?.toUpperCase()}</span>} checked={w.id === wsId} hint={w.role} onSelect={() => navigate(`/w/${w.id}`)}>
              {w.name}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem
            icon={<Plus size={15} />}
            onSelect={async () => {
              close();
              const name = await promptDialog({ title: 'New team workspace', label: 'Name', confirmLabel: 'Create' });
              if (!name) return;
              try {
                const { id } = await post<{ id: string }>('/workspaces', { name });
                await loadWorkspaces();
                navigate(`/w/${id}`);
              } catch (e) {
                errorToast(e);
              }
            }}
          >
            New workspace
          </MenuItem>
          <MenuItem icon={<Settings size={15} />} onSelect={() => navigate(`/w/${wsId}/settings?scope=workspace`)}>
            Workspace settings
          </MenuItem>
          <MenuItem icon={<Activity size={15} />} onSelect={() => navigate(`/w/${wsId}/activity`)}>
            Activity
          </MenuItem>
          <MenuItem icon={<Trash2 size={15} />} onSelect={() => navigate(`/w/${wsId}/trash`)}>
            Trash
          </MenuItem>
        </div>
      )}
    </Dropdown>
  );
}

const THEMES: { id: ThemePref; label: string; icon: typeof Sun }[] = [
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
  { id: 'hybrid', label: 'Hybrid', icon: Contrast },
  { id: 'system', label: 'System', icon: Monitor },
];

/** Light / Dark / Hybrid / System, as a row of toggle buttons (reused in the phone drawer). */
export function ThemeToggle() {
  const pref = useTheme((s) => s.pref);
  return (
    <div className="theme-toggle" role="group" aria-label="Theme">
      {THEMES.map(({ id, label, icon: Icon }) => (
        <button key={id} type="button" className={pref === id ? 'is-active' : ''} aria-pressed={pref === id} onClick={() => setThemePref(id)}>
          <Icon size={14} /> {label}
        </button>
      ))}
    </div>
  );
}

export function UserMenu({ wsId, full }: { wsId: string; full?: boolean }) {
  const user = useStore((s) => s.user!);
  const navigate = useNavigate();
  return (
    <Dropdown
      buttonClass={full ? 'sb-item user-menu-btn' : 'rail-btn rail-icon'}
      title="Account and settings"
      placement={full ? 'top-start' : 'right-end'}
      trigger={
        <>
          <Avatar user={user} size={full ? 22 : 26} />
          {full && <span className="truncate">{user.name}</span>}
        </>
      }
    >
      <div className="menu" role="menu" style={{ minWidth: 248 }}>
        <div className="user-menu-head">
          <strong className="truncate">{user.name}</strong>
          <span className="muted small truncate">{user.email}</span>
        </div>
        <MenuSeparator />
        <MenuLabel>Theme</MenuLabel>
        <ThemeToggle />
        <MenuSeparator />
        <MenuItem icon={<Settings size={15} />} onSelect={() => navigate(`/w/${wsId}/settings?scope=personal`)}>
          Settings
        </MenuItem>
        <MenuItem icon={<Keyboard size={15} />} hint="?" onSelect={() => ui.setShortcuts(true)}>
          Keyboard shortcuts
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon={<LogOut size={15} />} onSelect={() => void signOut().then(() => navigate('/login'))}>
          Sign out
        </MenuItem>
      </div>
    </Dropdown>
  );
}
