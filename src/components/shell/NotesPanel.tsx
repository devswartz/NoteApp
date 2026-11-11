// The Notes view's panels (OneNote-style):
//   panel 1 (NotesPanel): notebook picker, favourites, recent pages and the
//            selected notebook's section tree;
//   panel 2 (PagesPanel): the pages of the selected section (new page, sort,
//            drag to reorder).
// On narrow windows and phones there is no panel 2: `folded` lists each
// section's pages under it in the tree instead.
import type { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowDownUp, BookPlus, ChevronDown, Clock, FilePlus, Lock, Plus } from 'lucide-react';
import { patch, post } from '../../api.ts';
import { errorToast, useStore } from '../../store.ts';
import { Dropdown, IconButton, MenuItem, MenuLabel, MenuSeparator, useContextMenu } from '../ui.tsx';
import type { Notebook, PageMeta } from '../../../shared/types.ts';
import { sidebar, useSidebar, type PageSort } from './sidebarState.ts';
import { byPos, dragProps, dropClass, dropProps, moveNotebook, movePage, useDnd } from './treeDnd.ts';
import { promptDialog } from './dialogs.tsx';
import { openNewNotebook } from './NewNotebookDialog.tsx';
import { SharedWithMe } from '../sharing/SharedWithMe.tsx';
import { useShared } from '../sharing/sharedPages.ts';
import { childSections, notebookTarget, splitNotebooks, type NotesSelection } from './navState.ts';
import { NotebookMenu, PageRow, RenameInput, RowMenuButton, SectionNode, treeKeys, type NodeProps } from './notesRows.tsx';

const NONE: string[] = [];

export function NotesPanel({ sel, folded, isAdmin, ...p }: NodeProps & { sel: NotesSelection; folded: boolean; isAdmin: boolean }) {
  const tree = useStore((s) => s.tree);
  const treeLoaded = useStore((s) => s.treeLoaded);
  const me = useStore((s) => s.user!.id);
  const favorites = useSidebar((s) => s.favorites[p.wsId] ?? NONE);
  const recent = useSidebar((s) => s.recent[p.wsId] ?? NONE);
  const location = useLocation();
  const nb = tree.notebooks.find((n) => n.id === sel.notebookId);
  const pageById = new Map(tree.pages.map((pg) => [pg.id, pg]));
  const favPages = favorites.map((id) => pageById.get(id)).filter((pg): pg is PageMeta => !!pg);
  const recentPages = recent
    .map((id) => pageById.get(id))
    .filter((pg): pg is PageMeta => !!pg && !favorites.includes(pg.id) && !location.pathname.endsWith(`/p/${pg.id}`))
    .slice(0, 5);
  const sections = nb ? childSections(tree, nb.id, null) : [];
  const newSection = async () => {
    if (!nb) return;
    const name = await promptDialog({ title: `New section in ${nb.name}`, label: 'Name', confirmLabel: 'Create' });
    if (name) post(`/notebooks/${nb.id}/sections`, { name }).catch(errorToast);
  };

  return (
    <>
      <div className="panel-head">
        {nb ? (
          <NotebookPicker nb={nb} isMine={nb.createdBy === me} isAdmin={isAdmin} {...p} />
        ) : (
          <NotebookPicker nb={null} isMine={false} isAdmin={isAdmin} {...p} />
        )}
      </div>
      <div className="sb-scroll" onKeyDown={treeKeys}>
        <Group id={`fav:${p.wsId}`} title="Favourites" dropTarget hidden={!favPages.length}>
          {favPages.map((pg) => (
            <PageRow key={pg.id} page={pg} {...p} favorite />
          ))}
          {!favPages.length && <div className="sb-empty muted small">Drop a page here to pin it</div>}
        </Group>

        {recentPages.length > 0 && (
          <Group id={`recent:${p.wsId}`} title="Recent" icon={<Clock size={12} />} defaultClosed>
            {recentPages.map((pg) => (
              <PageRow key={pg.id} page={pg} {...p} flat />
            ))}
          </Group>
        )}

        {nb && (
          <Group
            id={`sections:${p.wsId}`}
            title="Sections"
            action={
              p.canEdit && (
                <IconButton label="New section" size="sm" onClick={newSection}>
                  <Plus size={15} />
                </IconButton>
              )
            }
          >
            <div role="tree" aria-label="Sections">
              {sections.map((s) => (
                <SectionNode key={s.id} section={s} selectedId={sel.sectionId} folded={folded} {...p} />
              ))}
            </div>
            {!sections.length && (
              <div className="sb-empty muted small">
                No sections yet.
                {p.canEdit && (
                  <button className="link" onClick={newSection}>
                    Add one
                  </button>
                )}
              </div>
            )}
          </Group>
        )}
        {!treeLoaded && <TreeSkeleton />}
        {treeLoaded && !tree.notebooks.length && (
          <div className="sb-empty muted small">
            No notebooks yet.
            {p.canEdit && (
              <button className="link" onClick={openNewNotebook}>
                Create one
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
}

/** The notebook dropdown: my notebooks, then "Shared with me" (others' notebooks and single shared pages). */
function NotebookPicker({ nb, isMine, isAdmin, ...p }: NodeProps & { nb: Notebook | null; isMine: boolean; isAdmin: boolean }) {
  const tree = useStore((s) => s.tree);
  const me = useStore((s) => s.user!.id);
  const sharedPages = useShared((s) => s.pages.length);
  const navigate = useNavigate();
  const drop = useDnd((s) => s.drop);
  const { mine, shared } = splitNotebooks(tree.notebooks, me);
  const menu = useContextMenu(() =>
    nb ? <NotebookMenu nb={nb} canEdit={p.canEdit} isMine={isMine} isAdmin={isAdmin} onRename={() => p.setEditing(nb.id)} /> : null,
  );
  const item = (n: Notebook) => (
    <div
      key={n.id}
      className={`nb-option ${dropClass(`pick-${n.id}`, drop)}`}
      {...dragProps('notebook', n.id, p.canEdit)}
      {...(p.canEdit
        ? dropProps('notebook', `pick-${n.id}`, (where) => {
            const drag = useDnd.getState().drag;
            if (drag?.kind === 'notebook') void moveNotebook(drag.id, n.id, where === 'inside' ? 'after' : where);
          })
        : {})}
    >
      <MenuItem
        icon={
          <span className="nb-icon" aria-hidden="true" style={{ background: n.color }}>
            {n.name[0]?.toUpperCase()}
          </span>
        }
        checked={n.id === nb?.id}
        hint={n.visibility === 'private' ? <Lock size={12} aria-label="Private notebook" /> : undefined}
        onSelect={() => navigate(notebookTarget(p.wsId, n.id))}
      >
        {n.name}
      </MenuItem>
    </div>
  );
  return (
    <div className="sb-row nb-row nb-picker" data-node={nb?.id} {...(nb ? menu.bind : {})}>
      {nb && p.editing === nb.id ? (
        <RenameInput
          value={nb.name}
          onDone={(v) => {
            p.setEditing(null);
            if (v) patch(`/notebooks/${nb.id}`, { name: v }).catch(errorToast);
          }}
        />
      ) : (
        <Dropdown
          buttonClass="nb-picker-btn"
          title="Switch notebook"
          nameFromContent
          className="nb-picker-pop"
          trigger={
            <>
              {nb ? (
                <span className="nb-icon" aria-hidden="true" style={{ background: nb.color }}>
                  {nb.name[0]?.toUpperCase()}
                </span>
              ) : (
                <BookPlus size={16} className="muted" />
              )}
              <span className="truncate sb-label">{nb?.name ?? 'Notebooks'}</span>
              {nb?.visibility === 'private' && <Lock size={12} className="muted" aria-label="Private notebook" />}
              <ChevronDown size={14} className="muted nb-picker-chev" />
            </>
          }
        >
          {(close) => (
            <div className="menu nb-menu" role="menu">
              {mine.length > 0 && <MenuLabel>My notebooks</MenuLabel>}
              {mine.map(item)}
              {(shared.length > 0 || sharedPages > 0) && <MenuLabel>Shared with me</MenuLabel>}
              {shared.map(item)}
              <SharedWithMe wsId={p.wsId} heading={false} onOpen={close} />
              {p.canEdit && (
                <>
                  <MenuSeparator />
                  <MenuItem icon={<BookPlus size={15} />} onSelect={openNewNotebook}>
                    New notebook
                  </MenuItem>
                </>
              )}
            </div>
          )}
        </Dropdown>
      )}
      {nb && (
        <div className="sb-row-actions always" onClick={(e) => e.stopPropagation()}>
          <RowMenuButton label="Notebook options" openAt={menu.openAt} />
        </div>
      )}
      {menu.menu}
    </div>
  );
}

const SORTS: [PageSort, string][] = [
  ['manual', 'Manual order'],
  ['title', 'Title'],
  ['updated', 'Last edited'],
];

export function sortPages(pages: PageMeta[], sort: PageSort): PageMeta[] {
  const out = [...pages];
  if (sort === 'title') return out.sort((a, b) => (a.title || 'Untitled').localeCompare(b.title || 'Untitled'));
  if (sort === 'updated') return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return out.sort(byPos);
}

/** Panel 2: the pages of the selected section. */
export function PagesPanel({ sectionId, ...p }: NodeProps & { sectionId: string | null }) {
  const tree = useStore((s) => s.tree);
  const sort = useSidebar((s) => s.pageSort);
  const drop = useDnd((s) => s.drop);
  const section = tree.sections.find((s) => s.id === sectionId);
  const pages = section ? sortPages(tree.pages.filter((pg) => pg.sectionId === section.id), sort) : [];
  return (
    <>
      <div className="panel-head">
        {section && <span className="sec-tab" style={{ background: section.color }} />}
        <h2 className="panel-title truncate">{section?.name ?? 'Pages'}</h2>
        {section && (
          <div className="panel-actions">
            <Dropdown buttonClass="btn-ghost icon-btn sm" title="Sort pages" placement="bottom-end" trigger={<ArrowDownUp size={15} />}>
              <div className="menu" role="menu">
                {SORTS.map(([id, label]) => (
                  <MenuItem key={id} checked={sort === id} onSelect={() => sidebar.setPageSort(id)}>
                    {label}
                  </MenuItem>
                ))}
              </div>
            </Dropdown>
            {p.canEdit && (
              <IconButton label="New page" size="sm" onClick={() => p.createPage(section.id)}>
                <FilePlus size={15} />
              </IconButton>
            )}
          </div>
        )}
      </div>
      <div
        className={`sb-scroll pages-list ${section ? dropClass(`pages-${section.id}`, drop) : ''}`}
        onKeyDown={treeKeys}
        {...(section && p.canEdit ? dropProps('section', `pages-${section.id}`, () => {
          const drag = useDnd.getState().drag;
          if (drag?.kind === 'page' || drag?.kind === 'favorite') void movePage(drag.id, section.id, null, 'inside');
        }) : {})}
      >
        <div role="tree" aria-label="Pages">
          {pages.map((pg) => (
            <PageRow key={pg.id} page={pg} draggable={sort === 'manual'} {...p} />
          ))}
        </div>
        {section && !pages.length && (
          <div className="panel-empty">
            <p className="muted small">No pages in this section yet.</p>
            {p.canEdit && (
              <button className="btn btn-secondary btn-sm" onClick={() => p.createPage(section.id)}>
                <Plus size={14} /> New page
              </button>
            )}
          </div>
        )}
        {!section && <p className="muted small panel-empty">Choose a section to see its pages.</p>}
      </div>
    </>
  );
}

export function Group({ id, title, icon, action, children, dropTarget, hidden, defaultClosed }: { id: string; title: string; icon?: ReactNode; action?: ReactNode; children: ReactNode; dropTarget?: boolean; hidden?: boolean; defaultClosed?: boolean }) {
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

