// The app sidebar: workspace switcher, quick actions, task views with counts,
// favourites, recent pages and the notebooks → sections → pages tree.
// Tree state (collapsed, favourites, recent, width) is in shell/sidebarState.ts;
// drag-and-drop in shell/treeDnd.ts.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  Activity,
  CalendarDays,
  CalendarRange,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Clock,
  Copy,
  FilePlus,
  FileText,
  FolderInput,
  Globe,
  Inbox,
  Link2,
  ListChecks,
  Lock,
  LogOut,
  MoreHorizontal,
  PanelLeftClose,
  Pencil,
  Plus,
  Search,
  Settings,
  Star,
  StarOff,
  Sun,
  Trash2,
  Users,
  UserPlus,
} from 'lucide-react';
import { del, patch, post } from '../api.ts';
import { errorToast, loadWorkspaces, signOut, toast, ui, useStore } from '../store.ts';
import { Avatar, Badge, Dropdown, IconButton, Kbd, MenuItem, MenuSeparator, MOD, useContextMenu, useIsMobile } from './ui.tsx';
import { isMine } from '../lib/taskViews.ts';
import { today } from '../../shared/dates.ts';
import type { Notebook, PageMeta, Section } from '../../shared/types.ts';
import { sidebar, useSidebar, SIDEBAR_MAX, SIDEBAR_MIN } from './shell/sidebarState.ts';
import { byPos, dragProps, dropClass, dropProps, moveNotebook, movePage, moveSection, useDnd } from './shell/treeDnd.ts';
import { confirmDialog, promptDialog } from './shell/dialogs.tsx';
import { MoveDialog } from './shell/MoveDialog.tsx';
import { NotificationBell } from './sharing/NotificationBell.tsx';
import { openNewNotebook } from './shell/NewNotebookDialog.tsx';
import { openShareDialog } from './sharing/ShareDialog.tsx';
import { SharedWithMe } from './sharing/SharedWithMe.tsx';
import { runCommand } from '../hooks/useShortcuts.ts';

const NONE: string[] = [];
type MoveItem = { kind: 'page' | 'section'; id: string } | null;

export function Sidebar() {
  const { wsId } = useParams() as { wsId: string };
  const user = useStore((s) => s.user!);
  const tree = useStore((s) => s.tree);
  const treeLoaded = useStore((s) => s.treeLoaded);
  const tasks = useStore((s) => s.tasks);
  const role = useStore((s) => s.workspaces.find((w) => w.id === s.wsId)?.role);
  const canEdit = role !== undefined && role !== 'viewer';
  const isAdmin = role === 'owner' || role === 'admin';
  const favorites = useSidebar((s) => s.favorites[wsId] ?? NONE);
  const recent = useSidebar((s) => s.recent[wsId] ?? NONE);
  const collapsed = useSidebar((s) => s.collapsed);
  const [editing, setEditing] = useState<string | null>(null);
  const [moving, setMoving] = useState<MoveItem>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile();
  const sidebarOpen = useStore((s) => s.sidebarOpen);

  // Close the drawer after navigating on mobile; remember visited pages.
  useEffect(() => {
    if (isMobile) ui.setSidebar(false);
    const pageId = location.pathname.match(/\/p\/([^/?#]+)/)?.[1];
    if (pageId) sidebar.visit(wsId, pageId);
  }, [location.pathname, isMobile, wsId]);

  const t = today();
  const in7 = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);
  const mine = Object.values(tasks).filter((x) => x.status === 'open' && isMine(x, user.id));
  const todayCount = mine.filter((x) => x.dueDate && x.dueDate <= t).length;
  const overdue = mine.some((x) => x.dueDate && x.dueDate < t);
  const upcomingCount = mine.filter((x) => x.dueDate && x.dueDate > t && x.dueDate <= in7).length;

  const pageById = new Map(tree.pages.map((p) => [p.id, p]));
  const favPages = favorites.map((id) => pageById.get(id)).filter((p): p is PageMeta => !!p);
  const recentPages = recent
    .map((id) => pageById.get(id))
    .filter((p): p is PageMeta => !!p && !favorites.includes(p.id) && !location.pathname.endsWith(`/p/${p.id}`))
    .slice(0, 5);

  const createPage = async (sectionId: string) => {
    try {
      const { id } = await post<{ id: string }>(`/sections/${sectionId}/pages`, { title: '' });
      sidebar.toggleNode(sectionId, false);
      useStore.setState((s) => ({
        tree: {
          ...s.tree,
          pages: [...s.tree.pages, { id, sectionId, title: '', icon: null, kind: 'document', position: 1e9, updatedAt: new Date().toISOString(), updatedBy: user.id }],
        },
      }));
      navigate(`/w/${wsId}/p/${id}`);
    } catch (e) {
      errorToast(e);
    }
  };

  const createNotebook = openNewNotebook;

  const nodeProps: NodeProps = { wsId, collapsed, editing, setEditing, canEdit, createPage, setMoving };

  return (
    <nav className="sidebar" aria-label="Sidebar">
      <div className="sb-top">
        <WorkspaceSwitcher />
        {/* The inbox lives here on desktop; the mobile top bar has its own, and AppShell shows one while the sidebar is hidden. */}
        {!isMobile && sidebarOpen && <NotificationBell size={17} />}
        {!isMobile && (
          <IconButton label="Hide sidebar" shortcut={`${MOD}\\`} onClick={ui.toggleSidebar}>
            <PanelLeftClose size={17} />
          </IconButton>
        )}
      </div>

      <div className="sb-actions">
        <button className="sb-item" onClick={ui.openPalette}>
          <Search size={16} /> <span>Search</span> <Kbd>{MOD}K</Kbd>
        </button>
        {canEdit && (
          <>
            <button className="sb-item sb-add" onClick={() => ui.openQuickAdd()}>
              <Plus size={16} /> <span>Add task</span> <Kbd>Q</Kbd>
            </button>
            <button className="sb-item" onClick={() => runCommand('pages.new')} disabled={!tree.sections.length}>
              <FilePlus size={16} /> <span>New page</span> <Kbd>N</Kbd>
            </button>
          </>
        )}
      </div>

      <div className="sb-scroll" onKeyDown={treeKeys}>
        <div className="sb-section">
          <NavItem to={`/w/${wsId}/tasks/today`} icon={<Sun size={16} />} label="Today" count={todayCount} danger={overdue} />
          <NavItem to={`/w/${wsId}/tasks/my`} icon={<Inbox size={16} />} label="My Tasks" count={mine.length} />
          <NavItem to={`/w/${wsId}/tasks/upcoming`} icon={<CalendarRange size={16} />} label="Upcoming" count={upcomingCount} />
          <NavItem to={`/w/${wsId}/tasks/team`} icon={<Users size={16} />} label="Team" />
          <NavItem to={`/w/${wsId}/tasks/all`} icon={<ListChecks size={16} />} label="All Tasks" />
          <NavItem to={`/w/${wsId}/tasks/calendar`} icon={<CalendarDays size={16} />} label="Calendar" />
          <NavItem to={`/w/${wsId}/tasks/completed`} icon={<CheckCircle2 size={16} />} label="Completed" />
          <NavItem to={`/w/${wsId}/activity`} icon={<Activity size={16} />} label="Activity" />
        </div>

        <Group id={`fav:${wsId}`} title="Favourites" dropTarget hidden={!favPages.length}>
          {favPages.map((p) => (
            <PageRow key={p.id} page={p} {...nodeProps} favorite />
          ))}
          {!favPages.length && <div className="sb-empty muted small">Drop a page here to pin it</div>}
        </Group>

        {recentPages.length > 0 && (
          <Group id={`recent:${wsId}`} title="Recent" icon={<Clock size={12} />} defaultClosed>
            {recentPages.map((p) => (
              <PageRow key={p.id} page={p} {...nodeProps} flat />
            ))}
          </Group>
        )}

        <Group
          id={`notebooks:${wsId}`}
          title="Notebooks"
          action={canEdit && (
            <IconButton label="New notebook" size="sm" onClick={createNotebook}>
              <Plus size={15} />
            </IconButton>
          )}
        >
          <div role="tree" aria-label="Notebooks">
            {[...tree.notebooks].sort(byPos).map((nb) => (
              <NotebookNode
                key={nb.id}
                nb={nb}
                sections={tree.sections.filter((s) => s.notebookId === nb.id).sort(byPos)}
                pages={tree.pages}
                isMine={nb.createdBy === user.id}
                isAdmin={isAdmin}
                {...nodeProps}
              />
            ))}
          </div>
          {!treeLoaded && <TreeSkeleton />}
          {treeLoaded && !tree.notebooks.length && (
            <div className="sb-empty muted small">
              No notebooks yet.
              {canEdit && (
                <button className="link" onClick={createNotebook}>
                  Create one
                </button>
              )}
            </div>
          )}
        </Group>

        <SharedWithMe wsId={wsId} />
      </div>

      <div className="sb-foot">
        <NavLink to={`/w/${wsId}/settings`} className="sb-item">
          <Avatar user={user} size={22} />
          <span className="truncate">{user.name}</span>
          <Settings size={15} className="muted" style={{ marginLeft: 'auto' }} />
        </NavLink>
      </div>

      {!isMobile && <Resizer />}
      <MoveDialog item={moving} onClose={() => setMoving(null)} />
    </nav>
  );
}

/** Up/Down move between rows; Left/Right collapse/expand (or go to the parent). */
function treeKeys(e: React.KeyboardEvent<HTMLDivElement>) {
  const t = e.target as HTMLElement;
  if (!t.classList.contains('sb-row') && !t.classList.contains('sb-item')) return;
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('.sb-item, .sb-row')].filter((r) => r.offsetParent !== null);
  const i = rows.indexOf(t);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && t.dataset.node) {
    const expanded = t.getAttribute('aria-expanded');
    if (e.key === 'ArrowRight' && expanded === 'false') (e.preventDefault(), sidebar.toggleNode(t.dataset.node, false));
    else if (e.key === 'ArrowLeft' && expanded === 'true') (e.preventDefault(), sidebar.toggleNode(t.dataset.node, true));
    else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      t.closest('[role=group]')?.parentElement?.querySelector<HTMLElement>(':scope > .sb-row')?.focus();
    }
  }
}

function Resizer() {
  const width = useSidebar((s) => s.width);
  const ref = useRef<HTMLDivElement>(null);
  // The app layout reads --sidebar-w.
  useEffect(() => {
    document.documentElement.style.setProperty('--sidebar-w', `${width}px`);
  }, [width]);
  return (
    <div
      ref={ref}
      className="sb-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={SIDEBAR_MAX}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onDoubleClick={sidebar.resetWidth}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') sidebar.setWidth(width - 16);
        if (e.key === 'ArrowRight') sidebar.setWidth(width + 16);
      }}
      onPointerDown={(e) => {
        e.preventDefault();
        const startX = e.clientX;
        const startW = width;
        document.body.classList.add('is-resizing');
        const move = (ev: PointerEvent) => sidebar.setWidth(startW + ev.clientX - startX);
        const up = () => {
          document.body.classList.remove('is-resizing');
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      }}
    />
  );
}

function Group({ id, title, icon, action, children, dropTarget, hidden, defaultClosed }: { id: string; title: string; icon?: ReactNode; action?: ReactNode; children: ReactNode; dropTarget?: boolean; hidden?: boolean; defaultClosed?: boolean }) {
  const closed = useSidebar((s) => s.collapsed[id] ?? !!defaultClosed);
  const drop = useDnd((s) => s.drop);
  const drag = useDnd((s) => s.drag);
  const wsId = id.split(':')[1];
  if (hidden && !drag) return null;
  const dp = dropTarget ? dropProps('favorites', id, () => drag && sidebar.toggleFavorite(wsId, drag.id)) : {};
  return (
    <div className="sb-group">
      <div className={`sb-heading ${dropClass(id, drop)}`} {...dp}>
        <button type="button" className="sb-heading-btn" aria-expanded={!closed} onClick={() => sidebar.toggleNode(id, !closed)}>
          {icon}
          <span>{title}</span>
          <ChevronDown size={12} className={`sb-heading-chev ${closed ? 'is-closed' : ''}`} />
        </button>
        {action}
      </div>
      {!closed && children}
    </div>
  );
}

function NavItem({ to, icon, label, count, danger }: { to: string; icon: ReactNode; label: string; count?: number; danger?: boolean }) {
  return (
    <NavLink to={to} className={({ isActive }) => `sb-item ${isActive ? 'is-active' : ''}`}>
      {icon}
      <span>{label}</span>
      {!!count && (
        <Badge tone={danger ? 'danger' : 'neutral'} className="sb-badge">
          {count}
        </Badge>
      )}
    </NavLink>
  );
}

function WorkspaceSwitcher() {
  const workspaces = useStore((s) => s.workspaces);
  const wsId = useStore((s) => s.wsId);
  const current = workspaces.find((w) => w.id === wsId);
  const navigate = useNavigate();
  return (
    <Dropdown
      buttonClass="ws-switch"
      title="Switch workspace"
      trigger={
        <>
          <span className="ws-logo">{current?.name[0]?.toUpperCase() ?? '·'}</span>
          <span className="truncate">{current?.name ?? 'Workspace'}</span>
          <ChevronDown size={14} className="muted" />
        </>
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
          <MenuItem icon={<Settings size={15} />} onSelect={() => navigate(`/w/${wsId}/settings?s=members`)}>
            Settings & members
          </MenuItem>
          <MenuItem icon={<LogOut size={15} />} onSelect={() => void signOut().then(() => navigate('/login'))}>
            Sign out
          </MenuItem>
        </div>
      )}
    </Dropdown>
  );
}

interface NodeProps {
  wsId: string;
  collapsed: Record<string, boolean>;
  editing: string | null;
  setEditing: (id: string | null) => void;
  canEdit: boolean;
  createPage: (sectionId: string) => void;
  setMoving: (m: MoveItem) => void;
}

function RenameInput({ value, onDone }: { value: string; onDone: (v: string | null) => void }) {
  const [v, setV] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.select(), []);
  return (
    <input
      ref={ref}
      className="input input-sm sb-rename"
      aria-label="New name"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => onDone(v.trim() && v !== value ? v.trim() : null)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') onDone(v.trim() && v !== value ? v.trim() : null);
        if (e.key === 'Escape') onDone(null);
      }}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

const PALETTE = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#64748b'];
function ColorRow({ value, onPick }: { value: string; onPick: (c: string) => void }) {
  return (
    <div className="color-row" role="group" aria-label="Colour">
      {PALETTE.map((c) => (
        <button key={c} type="button" className="swatch" style={{ background: c }} onClick={() => onPick(c)} aria-label={`Colour ${c}`} aria-pressed={c === value}>
          {c === value && <Check size={12} color="#fff" />}
        </button>
      ))}
    </div>
  );
}

/** "⋯" button that opens the same menu as right-click. */
function RowMenuButton({ label, openAt }: { label: string; openAt: (x: number, y: number) => void }) {
  return (
    <IconButton
      label={label}
      size="sm"
      tooltip={false}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        openAt(r.left, r.bottom + 2);
      }}
    >
      <MoreHorizontal size={15} />
    </IconButton>
  );
}

function NotebookNode({ nb, sections, pages, isMine, isAdmin, ...p }: NodeProps & { nb: Notebook; sections: Section[]; pages: PageMeta[]; isMine: boolean; isAdmin: boolean }) {
  const isCollapsed = !!p.collapsed[nb.id];
  const drop = useDnd((s) => s.drop);
  const newSection = async () => {
    const name = await promptDialog({ title: `New section in ${nb.name}`, label: 'Name', confirmLabel: 'Create' });
    if (name) post(`/notebooks/${nb.id}/sections`, { name }).then(() => sidebar.toggleNode(nb.id, false)).catch(errorToast);
  };
  const menu = useContextMenu(() => (
    <div className="menu" role="menu">
      {p.canEdit && (
        <MenuItem icon={<Plus size={15} />} onSelect={newSection}>
          New section
        </MenuItem>
      )}
      {p.canEdit && (
        <MenuItem icon={<Pencil size={15} />} onSelect={() => p.setEditing(nb.id)}>
          Rename
        </MenuItem>
      )}
      {isMine && (
        <MenuItem icon={<UserPlus size={15} />} onSelect={() => openShareDialog(nb.id)}>
          Share with people…
        </MenuItem>
      )}
      {isMine && (
        <MenuItem
          icon={nb.visibility === 'private' ? <Globe size={15} /> : <Lock size={15} />}
          onSelect={() =>
            patch<{ removedPageShares?: number }>(`/notebooks/${nb.id}`, { visibility: nb.visibility === 'private' ? 'shared' : 'private' })
              .then((r) => {
                const n = r.removedPageShares ?? 0; // single-page shares others granted end (#98)
                toast(nb.visibility === 'private' ? 'Notebook shared with the workspace' : `Notebook is now private to you${n ? `; ${n} page ${n === 1 ? 'share' : 'shares'} by others ended` : ''}`);
              })
              .catch(errorToast)
          }
        >
          {nb.visibility === 'private' ? 'Share with workspace' : 'Make private'}
        </MenuItem>
      )}
      {p.canEdit && <ColorRow value={nb.color} onPick={(color) => patch(`/notebooks/${nb.id}`, { color }).catch(errorToast)} />}
      {(isMine || isAdmin) && (
        <>
          <MenuSeparator />
          <MenuItem
            icon={<Trash2 size={15} />}
            danger
            onSelect={async () => {
              const ok = await confirmDialog({
                title: `Delete “${nb.name}”?`,
                message: 'All its sections and pages will be deleted. Tasks in those pages are kept as standalone tasks.',
                confirmLabel: 'Delete notebook',
                danger: true,
              });
              if (ok) del(`/notebooks/${nb.id}`).catch(errorToast);
            }}
          >
            Delete notebook
          </MenuItem>
        </>
      )}
    </div>
  ));
  return (
    <div className="nb" role="none">
      <div
        className={`sb-row nb-row ${dropClass(nb.id, drop)}`}
        role="treeitem"
        aria-expanded={!isCollapsed}
        data-node={nb.id}
        tabIndex={0}
        onClick={() => sidebar.toggleNode(nb.id)}
        onKeyDown={(e) => e.key === 'Enter' && sidebar.toggleNode(nb.id)}
        {...menu.bind}
        {...dragProps('notebook', nb.id, p.canEdit)}
        {...(p.canEdit
          ? dropProps('notebook', nb.id, (where) => {
              const drag = useDnd.getState().drag;
              if (drag?.kind === 'notebook') void moveNotebook(drag.id, nb.id, where);
              if (drag?.kind === 'section') void moveSection(drag.id, nb.id, null, 'inside');
            })
          : {})}
      >
        <span className="chev">{isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}</span>
        <span className="nb-icon" style={{ background: nb.color }}>
          {nb.name[0]?.toUpperCase()}
        </span>
        {p.editing === nb.id ? (
          <RenameInput
            value={nb.name}
            onDone={(v) => {
              p.setEditing(null);
              if (v) patch(`/notebooks/${nb.id}`, { name: v }).catch(errorToast);
            }}
          />
        ) : (
          <span className="truncate sb-label">{nb.name}</span>
        )}
        {nb.visibility === 'private' && <Lock size={12} className="muted" aria-label="Private notebook" />}
        <div className="sb-row-actions" onClick={(e) => e.stopPropagation()}>
          <RowMenuButton label="Notebook options" openAt={menu.openAt} />
        </div>
      </div>
      {menu.menu}
      {!isCollapsed && (
        <div className="nb-children" role="group">
          {sections.map((s) => (
            <SectionNode key={s.id} section={s} pages={pages.filter((pg) => pg.sectionId === s.id).sort(byPos)} {...p} />
          ))}
          {!sections.length && <div className="muted small sb-empty">No sections</div>}
        </div>
      )}
    </div>
  );
}

function SectionNode({ section, pages, ...p }: NodeProps & { section: Section; pages: PageMeta[] }) {
  const isCollapsed = !!p.collapsed[section.id];
  const drop = useDnd((s) => s.drop);
  const menu = useContextMenu(() => (
    <div className="menu" role="menu">
      <MenuItem icon={<FilePlus size={15} />} onSelect={() => p.createPage(section.id)}>
        New page
      </MenuItem>
      <MenuItem icon={<Pencil size={15} />} onSelect={() => p.setEditing(section.id)}>
        Rename
      </MenuItem>
      <MenuItem icon={<Copy size={15} />} onSelect={() => post(`/sections/${section.id}/copy`, {}).then(() => toast('Section duplicated')).catch(errorToast)}>
        Duplicate
      </MenuItem>
      <MenuItem icon={<FolderInput size={15} />} onSelect={() => p.setMoving({ kind: 'section', id: section.id })}>
        Move to…
      </MenuItem>
      <ColorRow value={section.color} onPick={(color) => patch(`/sections/${section.id}`, { color }).catch(errorToast)} />
      <MenuSeparator />
      <MenuItem
        icon={<Trash2 size={15} />}
        danger
        onSelect={async () => {
          const ok = await confirmDialog({
            title: `Delete “${section.name}”?`,
            message: `Its ${pages.length} page${pages.length === 1 ? '' : 's'} will be deleted. Tasks are kept as standalone tasks.`,
            confirmLabel: 'Delete section',
            danger: true,
          });
          if (ok) del(`/sections/${section.id}`).catch(errorToast);
        }}
      >
        Delete section
      </MenuItem>
    </div>
  ));
  return (
    <div className="sec" role="none">
      <div
        className={`sb-row sec-row ${dropClass(section.id, drop)}`}
        role="treeitem"
        aria-expanded={!isCollapsed}
        data-node={section.id}
        tabIndex={0}
        onClick={() => sidebar.toggleNode(section.id)}
        onKeyDown={(e) => e.key === 'Enter' && sidebar.toggleNode(section.id)}
        {...(p.canEdit ? menu.bind : {})}
        {...dragProps('section', section.id, p.canEdit)}
        {...(p.canEdit
          ? dropProps('section', section.id, (where) => {
              const drag = useDnd.getState().drag;
              if (drag?.kind === 'section') void moveSection(drag.id, section.notebookId, section.id, where);
              if (drag?.kind === 'page' || drag?.kind === 'favorite') void movePage(drag.id, section.id, null, 'inside');
            })
          : {})}
      >
        <span className="chev">{isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}</span>
        <span className="sec-tab" style={{ background: section.color }} />
        {p.editing === section.id ? (
          <RenameInput
            value={section.name}
            onDone={(v) => {
              p.setEditing(null);
              if (v) patch(`/sections/${section.id}`, { name: v }).catch(errorToast);
            }}
          />
        ) : (
          <span className="truncate sb-label">{section.name}</span>
        )}
        {p.canEdit && (
          <div className="sb-row-actions" onClick={(e) => e.stopPropagation()}>
            <IconButton label="New page" size="sm" tooltip={false} onClick={() => p.createPage(section.id)}>
              <Plus size={14} />
            </IconButton>
            <RowMenuButton label="Section options" openAt={menu.openAt} />
          </div>
        )}
      </div>
      {menu.menu}
      {!isCollapsed && (
        <div className="sec-children" role="group">
          {pages.map((pg) => (
            <PageRow key={pg.id} page={pg} {...p} />
          ))}
          {!pages.length && p.canEdit && (
            <button className="sb-row page-row muted" onClick={() => p.createPage(section.id)}>
              <Plus size={14} /> New page
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function PageRow({ page, favorite, flat, ...p }: NodeProps & { page: PageMeta; favorite?: boolean; flat?: boolean }) {
  const openTasks = useStore((s) => {
    let n = 0;
    for (const t of Object.values(s.tasks)) if (t.pageId === page.id && t.status === 'open') n++;
    return n;
  });
  const isFav = useSidebar((s) => (s.favorites[p.wsId] ?? []).includes(page.id));
  const drop = useDnd((s) => s.drop);
  const navigate = useNavigate();
  const rowId = favorite ? `fav-${page.id}` : flat ? `recent-${page.id}` : page.id;
  const menu = useContextMenu(() => (
    <div className="menu" role="menu">
      <MenuItem icon={isFav ? <StarOff size={15} /> : <Star size={15} />} onSelect={() => sidebar.toggleFavorite(p.wsId, page.id)}>
        {isFav ? 'Remove from favourites' : 'Add to favourites'}
      </MenuItem>
      <MenuItem
        icon={<Link2 size={15} />}
        onSelect={() => {
          const url = `${location.origin}/w/${p.wsId}/p/${page.id}`;
          navigator.clipboard?.writeText(url).then(() => toast('Link copied'), () => toast(url));
        }}
      >
        Copy link
      </MenuItem>
      {p.canEdit && (
        <>
          <MenuItem icon={<Pencil size={15} />} onSelect={() => p.setEditing(rowId)}>
            Rename
          </MenuItem>
          <MenuItem
            icon={<Copy size={15} />}
            onSelect={() =>
              post<{ id: string }>(`/pages/${page.id}/copy`, {})
                .then(({ id }) => navigate(`/w/${p.wsId}/p/${id}`))
                .catch(errorToast)
            }
          >
            Duplicate
          </MenuItem>
          <MenuItem icon={<FolderInput size={15} />} onSelect={() => p.setMoving({ kind: 'page', id: page.id })}>
            Move to…
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            icon={<Trash2 size={15} />}
            danger
            onSelect={async () => {
              const ok = await confirmDialog({
                title: `Delete “${page.title || 'Untitled'}”?`,
                message: 'Tasks in this page are kept as standalone tasks.',
                confirmLabel: 'Delete page',
                danger: true,
              });
              if (ok) del(`/pages/${page.id}`).catch(errorToast);
            }}
          >
            Delete page
          </MenuItem>
        </>
      )}
    </div>
  ));
  const dragKind = favorite ? 'favorite' : 'page';
  return (
    <>
      <NavLink
        to={`/w/${p.wsId}/p/${page.id}`}
        className={({ isActive }) => `sb-row page-row ${isActive ? 'is-active' : ''} ${dropClass(rowId, drop)}`}
        role="treeitem"
        {...menu.bind}
        // Viewers can still reorder their favourites (stored on this device only),
        // but nothing that moves pages on the server is draggable or a drop target for them.
        {...dragProps(dragKind, page.id, p.canEdit || !!favorite)}
        {...(flat || (!favorite && !p.canEdit)
          ? {}
          : dropProps(dragKind, rowId, (where) => {
              const drag = useDnd.getState().drag;
              if (!drag) return;
              if (favorite) {
                const list = useSidebar.getState().favorites[p.wsId] ?? [];
                if (drag.kind === 'page' && !list.includes(drag.id)) sidebar.toggleFavorite(p.wsId, drag.id);
                const rest = (useSidebar.getState().favorites[p.wsId] ?? []).filter((x) => x !== drag.id);
                const i = rest.indexOf(page.id);
                sidebar.moveFavorite(p.wsId, drag.id, where === 'after' ? i + 1 : i);
              } else if (drag.kind === 'page' || drag.kind === 'favorite') void movePage(drag.id, page.sectionId, page.id, where);
            }))}
      >
        {page.icon ? <span className="page-emoji">{page.icon}</span> : <FileText size={14} className="muted" />}
        {p.editing === rowId ? (
          <RenameInput
            value={page.title}
            onDone={(v) => {
              p.setEditing(null);
              if (v) patch(`/pages/${page.id}`, { title: v }).catch(errorToast);
            }}
          />
        ) : (
          <span className="truncate sb-label">{page.title || 'Untitled'}</span>
        )}
        {openTasks > 0 && (
          <span className="sb-count subtle" title={`${openTasks} open task(s)`}>
            <CircleCheck size={11} /> {openTasks}
          </span>
        )}
        <div className="sb-row-actions" onClick={(e) => (e.preventDefault(), e.stopPropagation())}>
          <RowMenuButton label="Page options" openAt={menu.openAt} />
        </div>
      </NavLink>
      {menu.menu}
    </>
  );
}

function TreeSkeleton() {
  return (
    <div className="sb-skeleton" aria-hidden="true">
      {[70, 55, 62, 48].map((w, i) => (
        <div key={i} className="sb-skeleton-row" style={{ paddingLeft: i === 0 ? 8 : 28 }}>
          <span className="skeleton" style={{ width: 14, height: 14 }} />
          <span className="skeleton" style={{ width: `${w}%`, height: 10 }} />
        </div>
      ))}
    </div>
  );
}
