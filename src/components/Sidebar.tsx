import { useEffect, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  CalendarDays,
  CalendarRange,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  FileText,
  Inbox,
  Lock,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Settings,
  Sun,
  Trash2,
  Users,
  ListChecks,
  LogOut,
  Globe,
  PanelLeftClose,
  Check,
} from 'lucide-react';
import { del, patch, post } from '../api.ts';
import { errorToast, loadWorkspaces, signOut, toast, ui, useStore } from '../store.ts';
import { Avatar, Dropdown, Kbd, MenuItem, MenuSeparator, MOD, useIsMobile } from './ui.tsx';
import { isMine } from '../lib/taskViews.ts';
import { today } from '../../shared/dates.ts';
import type { Notebook, PageMeta, Section } from '../../shared/types.ts';
import { platform } from '../platform/index.ts';

function useCollapsed() {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(platform.kv.get('noteapp.collapsed') ?? '{}');
    } catch {
      return {};
    }
  });
  const toggle = (id: string, value?: boolean) =>
    setCollapsed((c) => {
      const next = { ...c, [id]: value ?? !c[id] };
      platform.kv.set('noteapp.collapsed', JSON.stringify(next));
      return next;
    });
  return [collapsed, toggle] as const;
}

export function Sidebar() {
  const { wsId } = useParams() as { wsId: string };
  const user = useStore((s) => s.user!);
  const tree = useStore((s) => s.tree);
  const tasks = useStore((s) => s.tasks);
  const role = useStore((s) => s.workspaces.find((w) => w.id === s.wsId)?.role);
  const canEdit = role !== undefined && role !== 'viewer';
  const [collapsed, toggle] = useCollapsed();
  const [editing, setEditing] = useState<string | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile();

  // Close the drawer after navigating on mobile.
  useEffect(() => {
    if (isMobile) ui.setSidebar(false);
  }, [location.pathname, isMobile]);

  const t = today();
  const open = Object.values(tasks).filter((x) => x.status === 'open');
  const todayCount = open.filter((x) => isMine(x, user.id) && x.dueDate && x.dueDate <= t).length;
  const overdue = open.some((x) => isMine(x, user.id) && x.dueDate && x.dueDate < t);
  const myCount = open.filter((x) => isMine(x, user.id)).length;

  const createPage = async (sectionId: string) => {
    try {
      const { id } = await post<{ id: string }>(`/sections/${sectionId}/pages`, { title: '' });
      toggle(sectionId, false);
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

  const createNotebook = async () => {
    const name = prompt('Notebook name');
    if (!name?.trim()) return;
    try {
      const r = await post<{ id: string; sectionId: string }>(`/workspaces/${wsId}/notebooks`, { name, visibility: 'shared' });
      toggle(r.id, false);
      await createPage(r.sectionId);
    } catch (e) {
      errorToast(e);
    }
  };

  return (
    <nav className="sidebar" aria-label="Sidebar">
      <div className="sb-top">
        <WorkspaceSwitcher />
        {!isMobile && (
          <button className="btn-ghost icon-btn" onClick={ui.toggleSidebar} title={`Hide sidebar (${MOD}\\)`}>
            <PanelLeftClose size={17} />
          </button>
        )}
      </div>

      <div className="sb-actions">
        <button className="sb-item" onClick={ui.openPalette}>
          <Search size={16} /> <span>Search</span> <Kbd>{MOD}K</Kbd>
        </button>
        {canEdit && (
          <button className="sb-item sb-add" onClick={() => ui.openQuickAdd()}>
            <Plus size={16} /> <span>Add task</span> <Kbd>Q</Kbd>
          </button>
        )}
      </div>

      <div className="sb-scroll">
        <div className="sb-section">
          <NavItem to={`/w/${wsId}/tasks/today`} icon={<Sun size={16} />} label="Today" count={todayCount} danger={overdue} />
          <NavItem to={`/w/${wsId}/tasks/my`} icon={<Inbox size={16} />} label="My Tasks" count={myCount} />
          <NavItem to={`/w/${wsId}/tasks/upcoming`} icon={<CalendarRange size={16} />} label="Upcoming" />
          <NavItem to={`/w/${wsId}/tasks/team`} icon={<Users size={16} />} label="Team" />
          <NavItem to={`/w/${wsId}/tasks/all`} icon={<ListChecks size={16} />} label="All Tasks" />
          <NavItem to={`/w/${wsId}/tasks/calendar`} icon={<CalendarDays size={16} />} label="Calendar" />
          <NavItem to={`/w/${wsId}/tasks/completed`} icon={<CheckCircle2 size={16} />} label="Completed" />
        </div>

        <div className="sb-heading">
          <span>Notebooks</span>
          {canEdit && (
            <button className="btn-ghost icon-btn sm" onClick={createNotebook} title="New notebook">
              <Plus size={15} />
            </button>
          )}
        </div>

        {tree.notebooks.map((nb) => (
          <NotebookNode
            key={nb.id}
            nb={nb}
            sections={tree.sections.filter((s) => s.notebookId === nb.id)}
            pages={tree.pages}
            collapsed={collapsed}
            toggle={toggle}
            editing={editing}
            setEditing={setEditing}
            canEdit={canEdit}
            createPage={createPage}
            isMine={nb.createdBy === user.id}
            isAdmin={role === 'owner' || role === 'admin'}
          />
        ))}
        {!tree.notebooks.length && useStore.getState().treeLoaded && (
          <p className="muted small sb-empty">No notebooks yet.{canEdit && ' Create one with +.'}</p>
        )}
      </div>

      <div className="sb-foot">
        <NavLink to={`/w/${wsId}/settings`} className="sb-item">
          <Avatar user={user} size={22} />
          <span className="truncate">{user.name}</span>
          <Settings size={15} className="muted" style={{ marginLeft: 'auto' }} />
        </NavLink>
      </div>
    </nav>
  );
}

function NavItem({ to, icon, label, count, danger }: { to: string; icon: React.ReactNode; label: string; count?: number; danger?: boolean }) {
  return (
    <NavLink to={to} className={({ isActive }) => `sb-item ${isActive ? 'is-active' : ''}`}>
      {icon}
      <span>{label}</span>
      {!!count && <span className={`sb-count ${danger ? 'danger' : ''}`}>{count}</span>}
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
      trigger={
        <>
          <span className="ws-logo">{current?.name[0]?.toUpperCase() ?? '·'}</span>
          <span className="truncate">{current?.name ?? 'Workspace'}</span>
          <ChevronDown size={14} className="muted" />
        </>
      }
    >
      {(close) => (
        <div className="menu" style={{ minWidth: 240 }}>
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
              const name = prompt('Name your new team workspace');
              if (!name?.trim()) return;
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
          <MenuItem icon={<Settings size={15} />} onSelect={() => navigate(`/w/${wsId}/settings`)}>
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
  collapsed: Record<string, boolean>;
  toggle: (id: string, v?: boolean) => void;
  editing: string | null;
  setEditing: (id: string | null) => void;
  canEdit: boolean;
  createPage: (sectionId: string) => void;
}

function RenameInput({ value, onDone }: { value: string; onDone: (v: string | null) => void }) {
  const [v, setV] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.select(), []);
  return (
    <input
      ref={ref}
      className="input input-sm sb-rename"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => onDone(v.trim() && v !== value ? v.trim() : null)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onDone(v.trim() && v !== value ? v.trim() : null);
        if (e.key === 'Escape') onDone(null);
      }}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

function NotebookNode({
  nb,
  sections,
  pages,
  isMine,
  isAdmin,
  ...p
}: NodeProps & { nb: Notebook; sections: Section[]; pages: PageMeta[]; isMine: boolean; isAdmin: boolean }) {
  const isCollapsed = p.collapsed[nb.id];
  const [dropTarget, setDropTarget] = useState(false);
  return (
    <div className="nb">
      <div
        className={`sb-row nb-row ${dropTarget ? 'is-drop' : ''}`}
        onClick={() => p.toggle(nb.id)}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('application/x-section')) {
            e.preventDefault();
            setDropTarget(true);
          }
        }}
        onDragLeave={() => setDropTarget(false)}
        onDrop={(e) => {
          setDropTarget(false);
          const id = e.dataTransfer.getData('application/x-section');
          if (id) patch(`/sections/${id}`, { notebookId: nb.id, position: Date.now() / 1e12 + 1e6 }).catch(errorToast);
        }}
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
        {p.canEdit && (
          <div className="sb-row-actions" onClick={(e) => e.stopPropagation()}>
            <Dropdown trigger={<MoreHorizontal size={15} />} buttonClass="btn-ghost icon-btn sm" title="Notebook options">
              <div className="menu">
                <MenuItem
                  icon={<Plus size={15} />}
                  onSelect={async () => {
                    const name = prompt('Section name');
                    if (!name?.trim()) return;
                    post(`/notebooks/${nb.id}/sections`, { name }).then(() => p.toggle(nb.id, false)).catch(errorToast);
                  }}
                >
                  New section
                </MenuItem>
                <MenuItem icon={<Pencil size={15} />} onSelect={() => p.setEditing(nb.id)}>
                  Rename
                </MenuItem>
                {isMine && (
                  <MenuItem
                    icon={nb.visibility === 'private' ? <Globe size={15} /> : <Lock size={15} />}
                    onSelect={() =>
                      patch(`/notebooks/${nb.id}`, { visibility: nb.visibility === 'private' ? 'shared' : 'private' })
                        .then(() => toast(nb.visibility === 'private' ? 'Notebook shared with the workspace' : 'Notebook is now private to you'))
                        .catch(errorToast)
                    }
                  >
                    {nb.visibility === 'private' ? 'Share with workspace' : 'Make private'}
                  </MenuItem>
                )}
                <ColorRow value={nb.color} onPick={(color) => patch(`/notebooks/${nb.id}`, { color }).catch(errorToast)} />
                {(isMine || isAdmin) && (
                  <>
                    <MenuSeparator />
                    <MenuItem
                      icon={<Trash2 size={15} />}
                      danger
                      onSelect={() => {
                        if (confirm(`Delete notebook “${nb.name}” and all its pages? Tasks will be kept as standalone tasks.`))
                          del(`/notebooks/${nb.id}`).catch(errorToast);
                      }}
                    >
                      Delete notebook
                    </MenuItem>
                  </>
                )}
              </div>
            </Dropdown>
          </div>
        )}
      </div>
      {!isCollapsed && (
        <div className="nb-children">
          {sections.map((s) => (
            <SectionNode key={s.id} section={s} pages={pages.filter((pg) => pg.sectionId === s.id)} {...p} />
          ))}
          {!sections.length && <div className="muted small sb-empty">No sections</div>}
        </div>
      )}
    </div>
  );
}

const PALETTE = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#64748b'];
function ColorRow({ value, onPick }: { value: string; onPick: (c: string) => void }) {
  return (
    <div className="color-row">
      {PALETTE.map((c) => (
        <button key={c} className="swatch" style={{ background: c }} onClick={() => onPick(c)} aria-label={`Color ${c}`}>
          {c === value && <Check size={12} color="#fff" />}
        </button>
      ))}
    </div>
  );
}

function SectionNode({ section, pages, ...p }: NodeProps & { section: Section; pages: PageMeta[] }) {
  const isCollapsed = p.collapsed[section.id];
  const [drop, setDrop] = useState(false);
  const { wsId } = useParams();
  return (
    <div className="sec">
      <div
        className={`sb-row sec-row ${drop ? 'is-drop' : ''}`}
        onClick={() => p.toggle(section.id)}
        draggable={p.canEdit}
        onDragStart={(e) => e.dataTransfer.setData('application/x-section', section.id)}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('application/x-page')) {
            e.preventDefault();
            setDrop(true);
          }
        }}
        onDragLeave={() => setDrop(false)}
        onDrop={(e) => {
          setDrop(false);
          const id = e.dataTransfer.getData('application/x-page');
          if (!id) return;
          const max = Math.max(0, ...pages.map((x) => x.position));
          patch(`/pages/${id}`, { sectionId: section.id, position: max + 1 }).catch(errorToast);
          p.toggle(section.id, false);
        }}
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
            <button className="btn-ghost icon-btn sm" title="New page" onClick={() => p.createPage(section.id)}>
              <Plus size={14} />
            </button>
            <Dropdown trigger={<MoreHorizontal size={15} />} buttonClass="btn-ghost icon-btn sm" title="Section options">
              <div className="menu">
                <MenuItem icon={<Pencil size={15} />} onSelect={() => p.setEditing(section.id)}>
                  Rename
                </MenuItem>
                <ColorRow value={section.color} onPick={(color) => patch(`/sections/${section.id}`, { color }).catch(errorToast)} />
                <MenuSeparator />
                <MenuItem
                  icon={<Trash2 size={15} />}
                  danger
                  onSelect={() => {
                    if (confirm(`Delete section “${section.name}” and its ${pages.length} page(s)? Tasks will be kept.`))
                      del(`/sections/${section.id}`).catch(errorToast);
                  }}
                >
                  Delete section
                </MenuItem>
              </div>
            </Dropdown>
          </div>
        )}
      </div>
      {!isCollapsed && (
        <div className="sec-children">
          {pages.map((pg, i) => (
            <PageLink key={pg.id} page={pg} wsId={wsId!} canEdit={p.canEdit} prev={pages[i - 1]} />
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

function PageLink({ page, wsId, canEdit, prev }: { page: PageMeta; wsId: string; canEdit: boolean; prev?: PageMeta }) {
  const openTasks = useStore((s) => {
    let n = 0;
    for (const t of Object.values(s.tasks)) if (t.pageId === page.id && t.status === 'open') n++;
    return n;
  });
  const [drop, setDrop] = useState(false);
  return (
    <NavLink
      to={`/w/${wsId}/p/${page.id}`}
      className={({ isActive }) => `sb-row page-row ${isActive ? 'is-active' : ''} ${drop ? 'is-drop-before' : ''}`}
      draggable={canEdit}
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-page', page.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('application/x-page')) {
          e.preventDefault();
          e.stopPropagation();
          setDrop(true);
        }
      }}
      onDragLeave={() => setDrop(false)}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setDrop(false);
        const id = e.dataTransfer.getData('application/x-page');
        if (!id || id === page.id) return;
        // Place between the previous page and this one.
        const position = prev ? (prev.position + page.position) / 2 : page.position - 1;
        patch(`/pages/${id}`, { sectionId: page.sectionId, position }).catch(errorToast);
      }}
    >
      {page.icon ? <span>{page.icon}</span> : <FileText size={14} className="muted" />}
      <span className="truncate sb-label">{page.title || 'Untitled'}</span>
      {openTasks > 0 && (
        <span className="sb-count subtle" title={`${openTasks} open task(s)`}>
          <CircleCheck size={11} /> {openTasks}
        </span>
      )}
    </NavLink>
  );
}
