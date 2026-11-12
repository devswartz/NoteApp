// Rows of the Notes panels: the section tree (recursive, ready for Track 3's
// subsections), page rows, and the notebook options menu. Moved from Sidebar.tsx
// with every capability kept: context menus, inline rename, duplicate, move,
// share, private notebooks, colours, delete, drag and drop and task counts.
import { PageKindIcon } from '../PageKindIcon.tsx';
import { useEffect, useRef, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Copy,
  FileCog,
  FolderInput,
  FolderPlus,
  LayoutDashboard,
  LayoutTemplate,
  Globe,
  Link2,
  Lock,
  MoreHorizontal,
  Pencil,
  Plus,
  Printer,
  Star,
  StarOff,
  Trash2,
  UserPlus,
} from 'lucide-react';
import { del, patch, post } from '../../api.ts';
import { errorToast, toast, useStore } from '../../store.ts';
import { IconButton, MenuItem, MenuSeparator, useContextMenu } from '../ui.tsx';
import type { Notebook, PageMeta, Section } from '../../../shared/types.ts';
import { sidebar, useSidebar } from './sidebarState.ts';
import { byPos, dragProps, dropClass, dropProps, movePage, moveSection, useDnd } from './treeDnd.ts';
import { confirmDialog, promptDialog } from './dialogs.tsx';
import { openShareDialog } from '../sharing/ShareDialog.tsx';
import { childSections, sectionTarget } from './navState.ts';
import { MAX_SECTION_DEPTH, sectionDepth } from '../../../shared/sections.ts';
import { DefaultTemplateItems, NewFromTemplateItems, SectionDefaultBadge } from './SectionTemplates.tsx';

/** A menu with sub-views ("New page from template ▸"): state lives here, so it resets each time the menu opens. */
function MenuViews({ children }: { children: (view: string, setView: (v: string) => void) => React.ReactNode }) {
  const [view, setView] = useState('main');
  return <>{children(view, setView)}</>;
}

export type MoveItem = { kind: 'page' | 'section'; id: string } | null;

export interface NodeProps {
  wsId: string;
  collapsed: Record<string, boolean>;
  editing: string | null;
  setEditing: (id: string | null) => void;
  canEdit: boolean;
  /** `template`: 'default' (the usual: the section's default template, if any), a template id, or null for a blank page. */
  createPage: (sectionId: string, template?: 'default' | string | null) => void;
  setMoving: (m: MoveItem) => void;
}

export function RenameInput({ value, onDone }: { value: string; onDone: (v: string | null) => void }) {
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
      onClick={(e) => (e.stopPropagation(), e.preventDefault())}
    />
  );
}

const PALETTE = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#64748b'];
export function ColorRow({ value, onPick }: { value: string; onPick: (c: string) => void }) {
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
export function RowMenuButton({ label, openAt }: { label: string; openAt: (x: number, y: number) => void }) {
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

/** The notebook options menu (right-click on the notebook picker, or its "⋯"). */
export function NotebookMenu({ nb, canEdit, isMine, isAdmin, onRename }: { nb: Notebook; canEdit: boolean; isMine: boolean; isAdmin: boolean; onRename: () => void }) {
  const newSection = async () => {
    const name = await promptDialog({ title: `New section in ${nb.name}`, label: 'Name', confirmLabel: 'Create' });
    if (name) post(`/notebooks/${nb.id}/sections`, { name }).then(() => sidebar.toggleNode(nb.id, false)).catch(errorToast);
  };
  return (
    <div className="menu" role="menu">
      {canEdit && (
        <MenuItem icon={<Plus size={15} />} onSelect={newSection}>
          New section
        </MenuItem>
      )}
      {canEdit && (
        <MenuItem icon={<Pencil size={15} />} onSelect={onRename}>
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
      <MenuItem icon={<Printer size={15} />} onSelect={() => void import('../../print/print.ts').then((m) => m.printWithContentsChoice({ kind: 'notebook', id: nb.id }))}>
        Print…
      </MenuItem>
      {canEdit && <ColorRow value={nb.color} onPick={(color) => patch(`/notebooks/${nb.id}`, { color }).catch(errorToast)} />}
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
  );
}

/**
 * One section and, recursively, its subsections. Clicking selects it (opens its
 * last page). With `folded` (narrow windows, phones) the section's pages are
 * listed under it too, since there is no second panel.
 */
export function SectionNode({ section, selectedId, folded, depth = 0, ...p }: NodeProps & { section: Section; selectedId: string | null; folded: boolean; depth?: number }) {
  const tree = useStore((s) => s.tree);
  const navigate = useNavigate();
  const drop = useDnd((s) => s.drop);
  const subs = childSections(tree, section.notebookId, section.id);
  const pages = tree.pages.filter((pg) => pg.sectionId === section.id).sort(byPos);
  const selected = selectedId === section.id;
  const hasChildren = subs.length > 0 || (folded && (pages.length > 0 || p.canEdit));
  const isCollapsed = hasChildren && !!p.collapsed[section.id];
  const canNest = sectionDepth(tree, section.id) < MAX_SECTION_DEPTH;
  const createSubsection = async () => {
    const name = await promptDialog({ title: `New subsection in ${section.name}`, label: 'Name', confirmLabel: 'Create' });
    if (name) post(`/notebooks/${section.notebookId}/sections`, { name, parentId: section.id }).then(() => sidebar.toggleNode(section.id, false)).catch(errorToast);
  };
  const menu = useContextMenu(() => (
    <MenuViews>
      {(view, setView) =>
        view === 'from-template' ? (
          <div className="menu" role="menu" aria-label="New page from template">
            <MenuItem icon={<ChevronLeft size={15} />} onSelect={() => setView('main')} keepOpen>
              New page from template
            </MenuItem>
            <MenuSeparator />
            <NewFromTemplateItems sectionId={section.id} pick={(t) => p.createPage(section.id, t)} />
          </div>
        ) : view === 'default' ? (
          <div className="menu" role="menu" aria-label="Default template">
            <DefaultTemplateItems sectionId={section.id} onBack={() => setView('main')} />
          </div>
        ) : (
    <div className="menu" role="menu">
      <MenuItem icon={<LayoutDashboard size={15} />} onSelect={() => p.createPage(section.id)}>
        New page
      </MenuItem>
      <MenuItem icon={<LayoutTemplate size={15} />} onSelect={() => setView('from-template')} keepOpen hint={<ChevronRight size={13} />}>
        New page from template
      </MenuItem>
      <MenuItem icon={<FileCog size={15} />} onSelect={() => setView('default')} keepOpen>
        Default template…
      </MenuItem>
      {canNest && (
        <MenuItem icon={<FolderPlus size={15} />} onSelect={createSubsection}>
          New subsection
        </MenuItem>
      )}
      <MenuItem icon={<Pencil size={15} />} onSelect={() => p.setEditing(section.id)}>
        Rename
      </MenuItem>
      <MenuItem icon={<Copy size={15} />} onSelect={() => post(`/sections/${section.id}/copy`, {}).then(() => toast('Section duplicated')).catch(errorToast)}>
        Duplicate
      </MenuItem>
      <MenuItem icon={<FolderInput size={15} />} onSelect={() => p.setMoving({ kind: 'section', id: section.id })}>
        Move to…
      </MenuItem>
      <MenuItem icon={<Printer size={15} />} onSelect={() => void import('../../print/print.ts').then((m) => m.printWithContentsChoice({ kind: 'section', id: section.id }))}>
        Print…
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
        )
      }
    </MenuViews>
  ));
  const open = () => navigate(sectionTarget(p.wsId, section.id));
  return (
    <div className="sec" role="none">
      <div
        className={`sb-row sec-row ${selected ? 'is-selected' : ''} ${dropClass(section.id, drop)}`}
        role="treeitem"
        aria-selected={selected}
        aria-expanded={hasChildren ? !isCollapsed : undefined}
        aria-level={depth + 1}
        data-node={section.id}
        tabIndex={0}
        style={{ paddingLeft: 6 + depth * 14 }}
        onClick={open}
        onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && open()}
        {...(p.canEdit ? menu.bind : {})}
        {...dragProps('section', section.id, p.canEdit)}
        {...(p.canEdit
          ? dropProps('section', section.id, (where) => {
              const drag = useDnd.getState().drag;
              if (drag?.kind === 'section')
                void (where === 'inside'
                  ? moveSection(drag.id, section.notebookId, section.id, null, 'inside')
                  : moveSection(drag.id, section.notebookId, section.parentId ?? null, section.id, where));
              if (drag?.kind === 'page' || drag?.kind === 'favorite') void movePage(drag.id, section.id, null, 'inside');
            })
          : {})}
      >
        <span
          className={`chev ${hasChildren ? '' : 'is-leaf'}`}
          aria-hidden="true"
          onClick={(e) => {
            if (!hasChildren) return;
            e.stopPropagation();
            sidebar.toggleNode(section.id);
          }}
        >
          {hasChildren && (isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />)}
        </span>
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
        <SectionDefaultBadge sectionId={section.id} />
        {!folded && pages.length > 0 && <span className="sb-count subtle" aria-label={`${pages.length} pages`}>{pages.length}</span>}
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
      {hasChildren && !isCollapsed && (
        <div className="sec-children" role="group">
          {subs.map((s) => (
            <SectionNode key={s.id} section={s} selectedId={selectedId} folded={folded} depth={depth + 1} {...p} />
          ))}
          {folded && pages.map((pg) => <PageRow key={pg.id} page={pg} indent={depth + 1} {...p} />)}
          {folded && !pages.length && p.canEdit && (
            <button className="sb-row page-row sb-new-page muted" style={{ paddingLeft: 6 + (depth + 1) * 14 + 20 }} onClick={() => p.createPage(section.id)}>
              <Plus size={14} aria-hidden className="sb-new-page-icon" />
              <span className="truncate">New page</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function PageRow({ page, favorite, flat, draggable = true, indent, ...p }: NodeProps & { page: PageMeta; favorite?: boolean; flat?: boolean; draggable?: boolean; indent?: number }) {
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
        style={indent ? { paddingLeft: 6 + indent * 14 + 20 } : undefined}
        {...menu.bind}
        // Viewers can still reorder their favourites (stored on this device only),
        // but nothing that moves pages on the server is draggable or a drop target for them.
        {...dragProps(dragKind, page.id, (p.canEdit || !!favorite) && (draggable || !!favorite))}
        {...(flat || (!favorite && !p.canEdit) || (!favorite && !draggable)
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
        {page.icon ? <span className="page-emoji">{page.icon}</span> : <PageKindIcon kind={page.kind} size={14} className="muted" />}
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

/** Up/Down move between rows; Left/Right collapse/expand (or go to the parent). */
export function treeKeys(e: React.KeyboardEvent<HTMLElement>) {
  const t = e.target as HTMLElement;
  if (!t.classList.contains('sb-row') && !t.classList.contains('sb-item')) return;
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('.sb-item, .sb-row')].filter((r) => r.offsetParent !== null);
  const i = rows.indexOf(t);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  } else if (e.key === 'Home' || e.key === 'End') {
    e.preventDefault();
    rows[e.key === 'Home' ? 0 : rows.length - 1]?.focus();
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
