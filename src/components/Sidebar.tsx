// The context panels next to the rail (shell/Rail.tsx): one per view.
//   Notes    → shell/NotesPanel.tsx: notebook picker + section tree, and a second
//              panel with the selected section's pages (folded into the first
//              on narrow windows and phones)
//   Tasks    → shell/TasksPanel.tsx
//   Calendar → shell/CalendarPanel.tsx
// Settings and Activity keep the panel of the last view. On phones this is the
// drawer behind the top bar's menu button, with the workspace switcher and the
// user menu (there is no rail there). Device-local state (widths, collapsed
// nodes, favourites, the Notes selection) is in shell/sidebarState.ts.
import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { createPageIn } from '../editor/defaultTemplates.ts';
import { errorToast, ui, useStore } from '../store.ts';
import { useIsMobile, useMediaQuery } from './ui.tsx';
import { sidebar, useSidebar, PAGES_MAX, PAGES_MIN, SIDEBAR_MAX, SIDEBAR_MIN, type RailView } from './shell/sidebarState.ts';
import { MoveDialog } from './shell/MoveDialog.tsx';
import { useNotesSelection, viewOf } from './shell/navState.ts';
import { NotesPanel, PagesPanel } from './shell/NotesPanel.tsx';
import { TasksPanel } from './shell/TasksPanel.tsx';
import { CalendarPanel } from './shell/CalendarPanel.tsx';
import { UserMenu, WorkspaceSwitcher } from './shell/Rail.tsx';
import type { MoveItem, NodeProps } from './shell/notesRows.tsx';

/**
 * Below this width the pages list folds into the sections tree (one panel instead of two).
 * 1200 keeps two panels on a maximised 1920px screen at 150% Windows scaling (1280 wide).
 */
export const FOLD_QUERY = '(max-width: 1199px)';

export function Sidebar() {
  const { wsId } = useParams() as { wsId: string };
  const role = useStore((s) => s.workspaces.find((w) => w.id === s.wsId)?.role);
  const canEdit = role !== undefined && role !== 'viewer';
  const isAdmin = role === 'owner' || role === 'admin';
  const collapsed = useSidebar((s) => s.collapsed);
  const [editing, setEditing] = useState<string | null>(null);
  const [moving, setMoving] = useState<MoveItem>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile();
  const narrow = useMediaQuery(FOLD_QUERY);
  const pagesPanel = useSidebar((s) => s.pagesPanel);
  const folded = isMobile || narrow || !pagesPanel;
  const view = viewOf(location.pathname);
  const [lastView, setLastView] = useState<RailView>(view ?? 'tasks');
  const panel = view ?? lastView;
  const sel = useNotesSelection(wsId);

  useEffect(() => {
    if (isMobile) ui.setSidebar(false); // close the drawer after navigating
    const pageId = location.pathname.match(/\/p\/([^/?#]+)/)?.[1];
    if (pageId) sidebar.visit(wsId, pageId);
    if (view) {
      setLastView(view);
      sidebar.rememberLocation(wsId, view, location.pathname + location.search);
    }
  }, [location.pathname, location.search, isMobile, wsId, view]);

  // Remember the Notes selection (and the last page of each section) for next time.
  useEffect(() => {
    if (view === 'notes' && sel.notebookId) sidebar.selectNotes(wsId, sel.notebookId, sel.sectionId ?? undefined, sel.pageId ?? undefined);
  }, [view, wsId, sel.notebookId, sel.sectionId, sel.pageId]);

  // `template`: the section's default (New page), a chosen one (New page from template), or null for blank.
  const createPage = async (sectionId: string, template: 'default' | string | null = 'default') => {
    try {
      const { id } = await createPageIn(sectionId, template);
      sidebar.toggleNode(sectionId, false);
      navigate(`/w/${wsId}/p/${id}`);
    } catch (e) {
      errorToast(e);
    }
  };

  const nodeProps: NodeProps = { wsId, collapsed, editing, setEditing, canEdit, createPage, setMoving };
  const twoPanels = panel === 'notes' && !folded;

  return (
    <nav className={`sidebar view-${panel} ${twoPanels ? 'has-pages' : ''}`} aria-label="Sidebar">
      {isMobile && (
        <div className="sb-top">
          <WorkspaceSwitcher />
        </div>
      )}
      <div className="sb-panel" data-panel={panel}>
        {panel === 'notes' && <NotesPanel sel={sel} folded={folded} isAdmin={isAdmin} {...nodeProps} />}
        {panel === 'tasks' && <TasksPanel wsId={wsId} canEdit={canEdit} />}
        {panel === 'calendar' && <CalendarPanel wsId={wsId} />}
        {!isMobile && <PanelResizer which="panel" />}
      </div>
      {twoPanels && (
        <div className="pages-panel">
          <PagesPanel sectionId={sel.sectionId} {...nodeProps} />
          <PanelResizer which="pages" />
        </div>
      )}
      {isMobile && (
        <div className="sb-foot">
          <UserMenu wsId={wsId} full />
        </div>
      )}
      <MoveDialog item={moving} onClose={() => setMoving(null)} />
    </nav>
  );
}

/** Drag (or arrow keys) to resize a panel; double-click resets. Widths are kept per device. */
function PanelResizer({ which }: { which: 'panel' | 'pages' }) {
  const width = useSidebar((s) => (which === 'panel' ? s.width : s.pagesWidth));
  const setWidth = which === 'panel' ? sidebar.setWidth : sidebar.setPagesWidth;
  const cssVar = which === 'panel' ? '--sidebar-w' : '--pages-w';
  useEffect(() => {
    document.documentElement.style.setProperty(cssVar, `${width}px`);
  }, [width, cssVar]);
  return (
    <div
      className="sb-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={which === 'panel' ? 'Resize sidebar' : 'Resize pages panel'}
      aria-valuemin={which === 'panel' ? SIDEBAR_MIN : PAGES_MIN}
      aria-valuemax={which === 'panel' ? SIDEBAR_MAX : PAGES_MAX}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onDoubleClick={which === 'panel' ? sidebar.resetWidth : sidebar.resetPagesWidth}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') setWidth(width - 16);
        if (e.key === 'ArrowRight') setWidth(width + 16);
      }}
      onPointerDown={(e) => {
        e.preventDefault();
        const startX = e.clientX;
        const startW = width;
        document.body.classList.add('is-resizing');
        const move = (ev: PointerEvent) => setWidth(startW + ev.clientX - startX);
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
