import { useCallback, useEffect, useRef, useState, type TouchEvent as ReactTouchEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { Editor } from '@tiptap/react';
import { ChevronRight, CircleCheck, MoreHorizontal, Trash2, CloudOff, Check, Loader, FolderInput, Plus, ListTodo, MessageSquare, Copy, SmilePlus, FileText, History, FileDown, FileUp, Printer, LayoutTemplate, MoveHorizontal } from 'lucide-react';
import { api, get, patch, del, post, ApiError } from '../api.ts';
import { errorToast, toast, useStore } from '../store.ts';
import { PresenceStack } from '../editor/collabPresence.tsx';
import { CommentHighlights, CommentsPanel } from '../editor/collabCommentsPanel.tsx';
import { loadComments, useComments } from '../editor/collabComments.ts';
import { NoteEditor, type PresenceUser, type SaveState, type SyncStatus } from '../editor/NoteEditor.tsx';
import { IconPicker } from '../editor/IconPicker.tsx';
import { TemplatePicker } from '../editor/TemplatePicker.tsx';
import { saveAsTemplate } from '../editor/userTemplates.ts';
import { promptDialog } from '../components/shell/dialogs.tsx';
import { VersionHistory } from '../editor/VersionHistory.tsx';
import { exportMarkdown, importMarkdown, printPage } from '../editor/exportPage.ts';
import { Outline, usePageSetting } from '../editor/Outline.tsx';
import { insertTaskAtEnd } from '../editor/TaskRef.tsx';
import { Dropdown, MenuItem, MenuSeparator, useIsMobile } from '../components/ui.tsx';
import { TaskRow } from '../components/TaskRow.tsx';
import { relativeTime } from '../lib/format.ts';
import { sortTasks } from '../lib/taskViews.ts';
import { platform } from '../platform/index.ts';
import { ENTER, MOD, keyLabel } from '../components/ui.tsx';
import { setPagePanel, syncPagePanel, usePagePanel, type PagePanel } from '../store/ui.ts';
import { PageShareDialogHost, openPageShareDialog } from '../components/sharing/PageShareDialog.tsx';
import { loadSharedPageTasks, patchSharedPage, useShared } from '../components/sharing/sharedPages.ts';
import type { PageMeta } from '../../shared/types.ts';
import { UserPlus, Users } from 'lucide-react';

/** GET /pages/:id. viaPageShare: opened through a page share (#98), so it isn't in the tree. */
interface PageInfo {
  page: PageMeta;
  workspaceId: string;
  canEdit: boolean;
  canManage: boolean;
  canShare: boolean;
  viaPageShare: boolean;
  member: boolean;
}

export function PageView() {
  const { wsId, pageId } = useParams() as { wsId: string; pageId: string };
  const user = useStore((s) => s.user!);
  const treeMeta = useStore((s) => s.tree.pages.find((p) => p.id === pageId));
  // undefined while loading, null when it failed (offline, or no access).
  const [info, setInfo] = useState<PageInfo | null | undefined>(undefined);
  const [gone, setGone] = useState(false);
  const shareKey = useShared((s) => {
    const sp = s.pages.find((x) => x.id === pageId);
    return sp ? `${sp.canEdit}` : '-';
  });
  const meta = treeMeta ?? (info?.viaPageShare ? info.page : undefined);
  const section = useStore((s) => s.tree.sections.find((x) => x.id === meta?.sectionId));
  const notebook = useStore((s) => s.tree.notebooks.find((x) => x.id === section?.notebookId));
  const treeLoaded = useStore((s) => s.treeLoaded);
  const updatedBy = useStore((s) => s.members.find((m) => m.id === meta?.updatedBy));
  const [canEdit, setCanEdit] = useState<boolean | null>(null);
  const [status, setStatus] = useState<SyncStatus>('connecting');
  const [save, setSave] = useState<SaveState>('saved');
  const [synced, setSynced] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    setSynced(false);
    setHistoryOpen(false);
  }, [pageId]);
  const [presence, setPresence] = useState<PresenceUser[]>([]);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [fullWidth, setFullWidth] = usePageSetting(editor, 'fullWidth', false);
  const isMobile = useIsMobile();
  // Tasks / comments panel (#99): never opens by itself. Desktop restores the
  // last choice on this device; phones always open a page as just the note.
  const storedPanel = usePagePanel((s) => s.panel);
  const [phonePanel, setPhonePanel] = useState<PagePanel>(null);
  useEffect(() => {
    syncPagePanel(); // the shell's storage may have been swapped in after the store loaded
    setPhonePanel(null);
  }, [pageId]);
  const panel = isMobile ? phonePanel : storedPanel;
  const showPanel = useCallback(
    (p: PagePanel) => {
      setPagePanel(p);
      setPhonePanel(p);
    },
    [],
  );
  const togglePanel = (p: Exclude<PagePanel, null>) => showPanel(panel === p ? null : p);
  const openTasks = useStore((s) => Object.values(s.tasks).filter((t) => t.pageId === pageId && t.status === 'open').length);
  const openThreads = useComments((s) => (s.pageId === pageId ? s.threads.filter((t) => !t.resolvedAt).length : 0));
  // Highlights need the threads even while the panel is closed.
  useEffect(() => {
    void loadComments(pageId);
  }, [pageId]);
  // Starting a comment (or clicking a highlighted one) opens Comments so the composer/thread is visible.
  const commentPending = useComments((s) => !!s.pending || !!s.activeId);
  useEffect(() => {
    if (commentPending) setPhonePanel('comments');
    if (commentPending && usePagePanel.getState().panel !== 'comments') setPagePanel('comments');
  }, [commentPending]);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  // Re-checked when your role changes (a live `workspaces` event reloads it), so a member
  // demoted to viewer goes read-only without a reload (BUG-2b).
  const role = useStore((s) => s.workspaces.find((w) => w.id === wsId)?.role);
  useEffect(() => {
    setCanEdit(null);
    setInfo(undefined);
    setGone(false);
  }, [pageId]);
  useEffect(() => {
    let cancelled = false;
    // Remember edit rights so a page opened offline stays editable (changes sync on reconnect).
    const key = `noteapp.canEdit.${user.id}.${pageId}`;
    get<PageInfo>(`/pages/${pageId}`)
      .then((r) => {
        platform.kv.set(key, r.canEdit ? '1' : '0');
        if (cancelled) return;
        setCanEdit(r.canEdit);
        setInfo(r);
        // A page shared from another workspace: its tasks aren't in this workspace's store (#98).
        if (r.viaPageShare && r.workspaceId !== wsId) loadSharedPageTasks(pageId).catch(() => {});
      })
      .catch((e) => {
        if (cancelled) return;
        setInfo(null);
        if (e instanceof ApiError && e.status === 404) setGone(true); // e.g. a page share was revoked
        else setCanEdit(platform.kv.get(key) === '1');
      });
    platform.kv.set(`noteapp.lastPage.${wsId}`, pageId);
    return () => {
      cancelled = true;
    };
  }, [pageId, wsId, role, shareKey]);

  // Deep link to a task inside the note (?task=id): scroll to it and flash.
  const focusTask = params.get('task');
  useEffect(() => {
    if (!focusTask || !editor) return;
    let tries = 0;
    const iv = setInterval(() => {
      const el = document.querySelector(`.task-ref[data-task-id="${focusTask}"]`);
      if (el || ++tries > 30) {
        clearInterval(iv);
        if (el) {
          el.scrollIntoView({ block: 'center', behavior: 'smooth' });
          el.classList.add('flash');
          setTimeout(() => el.classList.remove('flash'), 1800);
        }
        params.delete('task');
        setParams(params, { replace: true });
      }
    }, 150);
    return () => clearInterval(iv);
  }, [focusTask, editor]); // eslint-disable-line react-hooks/exhaustive-deps

  const onReady = useCallback((e: Editor) => setEditor(e), []);

  if ((treeLoaded && !meta && info !== undefined) || (gone && !treeMeta)) {
    return (
      <div className="empty-page">
        <h2>Page not found</h2>
        <p className="muted">It may have been deleted, moved to a private notebook, or you don't have access.</p>
        <button className="btn btn-secondary" onClick={() => navigate(`/w/${wsId}/tasks/today`)}>
          Go to Today
        </button>
      </div>
    );
  }
  if (!meta || canEdit === null) return <div className="page-loading" />;

  return (
    <div className={`page-layout ${panel && !isMobile ? 'with-panel' : ''}`}>
      <div className="page-scroll" ref={setScroller}>
        {editor && !fullWidth && !isMobile && <Outline editor={editor} scroller={scroller} />}
        <header className="page-topbar">
          <div className="crumbs">
            {notebook ? (
              <>
                <span className="crumb">
                  <span className="dot" style={{ background: notebook.color }} />
                  {notebook.name}
                </span>
                <ChevronRight size={14} className="muted" />
                {section && <span className="crumb">{section.name}</span>}
              </>
            ) : (
              info?.viaPageShare && (
                <span className="crumb">
                  <Users size={13} /> Shared with me
                </span>
              )
            )}
          </div>
          <div className="topbar-right">
            <PresenceStack users={presence} />
            <SaveIndicator status={status} save={save} />
            {!canEdit && <span className="chip">View only</span>}
            <button
              className={`btn-ghost icon-btn panel-toggle ${panel === 'tasks' ? 'is-active' : ''}`}
              title="Tasks on this page"
              aria-pressed={panel === 'tasks'}
              onClick={() => togglePanel('tasks')}
            >
              <ListTodo size={18} aria-hidden />
              {/* The name comes from the content so it contains the visible count (axe: label-content-name-mismatch). */}
              <span className="sr-only">Tasks on this page</span>
              {openTasks > 0 && <PanelBadge n={openTasks} />}
            </button>
            <button
              className={`btn-ghost icon-btn panel-toggle ${panel === 'comments' ? 'is-active' : ''}`}
              title="Comments"
              aria-pressed={panel === 'comments'}
              onClick={() => togglePanel('comments')}
            >
              <MessageSquare size={18} aria-hidden />
              <span className="sr-only">Comments</span>
              {openThreads > 0 && <PanelBadge n={openThreads} />}
            </button>
            {info?.canShare && (
              <button className="btn btn-secondary btn-sm page-share-btn" onClick={() => openPageShareDialog(pageId, meta.title)}>
                <UserPlus size={14} /> Share
              </button>
            )}
            {(canEdit || info?.canShare) && (
              <PageMenu
                pageId={pageId}
                wsId={wsId}
                editor={editor}
                onHistory={() => setHistoryOpen(true)}
                fullWidth={fullWidth}
                onFullWidth={setFullWidth}
                canManage={info ? info.canManage : !!treeMeta}
                canShare={!!info?.canShare}
                canEdit={canEdit}
                title={meta.title}
              />
            )}
          </div>
        </header>

        <article className={`page-article ${fullWidth ? 'is-full' : ''}`}>
          <PageIcon pageId={pageId} icon={meta.icon} canEdit={canEdit} />
          <TitleInput key={`title-${pageId}`} pageId={pageId} initial={meta.title} canEdit={canEdit} onEnter={() => editor?.commands.focus('start')} />
          <div className="page-sub muted small">
            Edited {relativeTime(meta.updatedAt)}
            {updatedBy ? ` by ${updatedBy.id === user.id ? 'you' : updatedBy.name}` : ''}
          </div>
          <NoteEditor
            key={`editor-${pageId}`}
            pageId={pageId}
            workspaceId={wsId}
            user={user}
            canEdit={canEdit}
            onStatus={setStatus}
            onSave={setSave}
            onServerSynced={() => setSynced(true)}
            onPresence={setPresence}
            onReady={onReady}
          />
          {canEdit && editor && synced && <TemplatePicker key={pageId} editor={editor} pageId={pageId} />}
          {canEdit && editor && (
            <button className="add-task-end" onClick={() => insertTaskAtEnd(editor, pageId)}>
              <Plus size={15} /> Add a task to this page
            </button>
          )}
          <Backlinks pageId={pageId} wsId={wsId} />
        </article>
      </div>
      <VersionHistory pageId={pageId} editor={editor} open={historyOpen} onClose={() => setHistoryOpen(false)} othersEditing={presence.length} />
      <CommentHighlights />
      <PageShareDialogHost />
      {panel && <PageSidePanel pageId={pageId} tab={panel} onTab={showPanel} canComment={!!canEdit} onClose={() => showPanel(null)} mobile={isMobile} />}
    </div>
  );
}

/** "Saved" / "Saving…" / "Offline": everything typed is in IndexedDB at once and on the server shortly after. */
function SaveIndicator({ status, save }: { status: SyncStatus; save: SaveState }) {
  const offline = status !== 'live' || save === 'offline';
  const state = status === 'connecting' ? 'connecting' : offline ? 'offline' : save;
  const label = { connecting: 'Connecting…', offline: 'Offline', saving: 'Saving…', saved: 'Saved' }[state];
  const title = {
    connecting: 'Connecting to the server…',
    offline: 'Offline. Your edits are saved on this device and will sync when you reconnect.',
    saving: 'Saving your latest changes…',
    saved: 'All changes saved and syncing live.',
  }[state];
  const icon = state === 'offline' ? <CloudOff size={14} /> : state === 'saved' ? <Check size={14} /> : <Loader size={14} className="spin" />;
  return (
    <span className={`sync sync-${status} save-${state}`} title={title} role="status" aria-live="polite">
      {icon}
      <span className="sync-label">{label}</span>
    </span>
  );
}

function setPageIcon(pageId: string, icon: string | null) {
  useStore.setState((s) => ({ tree: { ...s.tree, pages: s.tree.pages.map((p) => (p.id === pageId ? { ...p, icon } : p)) } }));
  patch(`/pages/${pageId}`, { icon }).catch(errorToast);
}

function PageIcon({ pageId, icon, canEdit }: { pageId: string; icon: string | null; canEdit: boolean }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  if (!icon && !canEdit) return null;
  return (
    <div className={`page-icon-row ${icon ? 'has-icon' : ''}`}>
      <button
        ref={anchor}
        type="button"
        className={icon ? 'page-icon' : 'btn-ghost btn-sm page-icon-add'}
        disabled={!canEdit}
        title={canEdit ? (icon ? 'Change icon' : 'Add icon') : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        {icon ?? (
          <>
            <SmilePlus size={15} /> Add icon
          </>
        )}
      </button>
      <IconPicker
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        hasIcon={!!icon}
        onPick={(e) => {
          setPageIcon(pageId, e);
          setOpen(false);
        }}
      />
    </div>
  );
}

function TitleInput({ pageId, initial, canEdit, onEnter }: { pageId: string; initial: string; canEdit: boolean; onEnter: () => void }) {
  const [title, setTitle] = useState(initial);
  const treeTitle = useStore((s) => s.tree.pages.find((p) => p.id === pageId)?.title);
  const sharedTitle = useShared((s) => s.pages.find((p) => p.id === pageId)?.title);
  const remote = treeTitle ?? sharedTitle ?? initial; // a shared page isn't in the tree (#98)
  const focused = useRef(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!focused.current) setTitle(remote);
  }, [remote]);
  // Title saves are debounced while typing, but a pending save is never dropped: it's flushed
  // when the page changes or unmounts (navigating away) and when the tab is hidden or closed
  // (keepalive, so the request outlives the page). BUG-3.
  const pending = useRef<string | null>(null);
  const flush = useRef(() => {});
  flush.current = () => {
    const next = pending.current;
    if (next === null) return;
    pending.current = null;
    useStore.setState((s) => ({ tree: { ...s.tree, pages: s.tree.pages.map((p) => (p.id === pageId ? { ...p, title: next } : p)) } }));
    patchSharedPage(pageId, { title: next });
    api(`/pages/${pageId}`, { method: 'PATCH', json: { title: next }, keepalive: true }).catch(errorToast);
  };
  useEffect(() => {
    if (title === remote) {
      pending.current = null;
      return;
    }
    pending.current = title;
    const t = setTimeout(() => flush.current(), 400);
    return () => clearTimeout(t);
  }, [title]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onHide = () => flush.current();
    const onVisibility = () => document.visibilityState === 'hidden' && flush.current();
    window.addEventListener('pagehide', onHide);
    window.addEventListener('beforeunload', onHide);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('beforeunload', onHide);
      document.removeEventListener('visibilitychange', onVisibility);
      flush.current(); // unmount: the component is keyed by page id, so this also covers switching pages
    };
  }, []);
  useEffect(() => {
    // Auto-size and focus new, empty pages.
    if (ref.current) {
      ref.current.style.height = 'auto';
      ref.current.style.height = ref.current.scrollHeight + 'px';
    }
  }, [title]);
  useEffect(() => {
    if (!initial && canEdit) ref.current?.focus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <textarea
      ref={ref}
      className="page-title"
      rows={1}
      value={title}
      placeholder="Untitled"
      readOnly={!canEdit}
      onFocus={() => (focused.current = true)}
      onBlur={() => (focused.current = false)}
      onChange={(e) => setTitle(e.target.value.replace(/\n/g, ''))}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === 'ArrowDown') {
          e.preventDefault();
          onEnter();
        }
      }}
    />
  );
}

function PageMenu({
  pageId,
  wsId,
  editor,
  onHistory,
  fullWidth,
  onFullWidth,
  canManage,
  canShare,
  canEdit,
  title,
}: {
  pageId: string;
  wsId: string;
  editor: Editor | null;
  onHistory: () => void;
  fullWidth: boolean;
  onFullWidth: (v: boolean) => void;
  /** Notebook-level edit: duplicate, template, move, copy, delete. Not for page-share-only access (#98). */
  canManage: boolean;
  canShare: boolean;
  canEdit: boolean;
  title: string;
}) {
  const tree = useStore((s) => s.tree);
  const navigate = useNavigate();
  const current = tree.pages.find((p) => p.id === pageId);
  const [mode, setMode] = useState<'move' | 'copy'>('move');
  const sectionsOf = (notebookId: string) => tree.sections.filter((s) => s.notebookId === notebookId);
  const inPrivate = tree.notebooks.find((n) => n.id === tree.sections.find((s) => s.id === current?.sectionId)?.notebookId)?.visibility === 'private';
  /** "Save as template": a snapshot of the live editor content; the server copies the page's tasks (as new ones) and attachments. */
  const saveTemplate = async () => {
    if (!editor) return;
    const name = await promptDialog({
      title: 'Save page as template',
      label: 'Template name',
      initial: current?.title || 'Untitled',
      confirmLabel: 'Save template',
      message: inPrivate
        ? 'This page is in a private notebook, so only you will see the template. Its tasks become new tasks each time it is used, and attachments are copied.'
        : 'Everyone in this workspace will be able to see and use this template. Its tasks become new tasks each time it is used (title, priority and subtasks only), and attachments are copied.',
    });
    if (!name) return;
    saveAsTemplate(editor, pageId, name, current?.icon)
      .then((t) =>
        toast(
          t.visibility === 'private'
            ? inPrivate
              ? 'Template saved (only you can see it)'
              : 'Template saved, but only you can see it: it includes private tasks or files'
            : 'Template saved for the workspace',
        ),
      )
      .catch(errorToast);
  };
  const run = (sectionId: string, label: string) => {
    if (mode === 'move') {
      if (current?.sectionId === sectionId) return;
      post(`/pages/${pageId}/move`, { sectionId })
        .then(() => toast(`Moved to ${label}`))
        .catch(errorToast);
    } else {
      post<{ id: string }>(`/pages/${pageId}/copy`, { sectionId })
        .then((r) => {
          toast(`Copied to ${label}`, { action: { label: 'Open', run: () => navigate(`/w/${wsId}/p/${r.id}`) } });
        })
        .catch(errorToast);
    }
  };
  return (
    <Dropdown trigger={<MoreHorizontal size={18} />} buttonClass="btn-ghost icon-btn" title="Page options" placement="bottom-end" className="menu-scroll">
      {() => (
        <div className="menu page-menu">
          {canShare && (
            <>
              <MenuItem icon={<UserPlus size={15} />} onSelect={() => openPageShareDialog(pageId, current?.title ?? title)}>
                Share…
              </MenuItem>
              <MenuSeparator />
            </>
          )}
          {canManage && (
            <MenuItem
              icon={<Copy size={15} />}
            onSelect={() => {
              post<{ id: string }>(`/pages/${pageId}/copy`, {})
                .then((r) => {
                  toast('Page duplicated');
                  navigate(`/w/${wsId}/p/${r.id}`);
                })
                .catch(errorToast);
            }}
          >
              Duplicate
            </MenuItem>
          )}
          {canManage && (
            <MenuItem icon={<LayoutTemplate size={15} />} onSelect={() => editor && void saveTemplate()}>
              Save as template…
            </MenuItem>
          )}
          <MenuItem icon={<History size={15} />} onSelect={onHistory}>
            Version history
          </MenuItem>
          <MenuItem icon={<MoveHorizontal size={15} />} checked={fullWidth} onSelect={() => onFullWidth(!fullWidth)}>
            Full width
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<FileDown size={15} />} onSelect={() => editor && void exportMarkdown(editor, pageId).catch(errorToast)}>
            Export as Markdown
          </MenuItem>
          <MenuItem icon={<Printer size={15} />} onSelect={() => printPage(current?.title ?? '')}>
            Print / save as PDF
          </MenuItem>
          {canEdit && (
            <MenuItem icon={<FileUp size={15} />} onSelect={() => editor && void importMarkdown(editor, pageId)}>
              Import Markdown…
            </MenuItem>
          )}
          {canManage && (
            <>
            <MenuSeparator />
            <div className="seg page-menu-seg" role="tablist">
              <button type="button" role="tab" aria-selected={mode === 'move'} className={mode === 'move' ? 'is-active' : ''} onClick={() => setMode('move')}>
                <FolderInput size={13} /> Move to
              </button>
              <button type="button" role="tab" aria-selected={mode === 'copy'} className={mode === 'copy' ? 'is-active' : ''} onClick={() => setMode('copy')}>
                <Copy size={13} /> Copy to
              </button>
            </div>
            {tree.notebooks.map((n) => (
              <div key={n.id}>
                <div className="menu-group-title">{n.name}</div>
                {sectionsOf(n.id).map((s) => (
                  <MenuItem
                    key={s.id}
                    icon={<span className="dot" style={{ background: s.color }} />}
                    checked={mode === 'move' && current?.sectionId === s.id}
                    onSelect={() => run(s.id, `${n.name} › ${s.name}`)}
                  >
                    {s.name}
                  </MenuItem>
                ))}
              </div>
            ))}
            <MenuSeparator />
            <MenuItem
              icon={<Trash2 size={15} />}
              danger
              onSelect={() => {
                if (!confirm('Delete this page? Tasks on it will be kept as standalone tasks.')) return;
                del(`/pages/${pageId}`)
                  .then(() => {
                    toast('Page deleted');
                    navigate(`/w/${wsId}/notes`);
                  })
                  .catch(errorToast);
              }}
            >
              Delete page
            </MenuItem>
            </>
          )}
        </div>
      )}
    </Dropdown>
  );
}

interface Backlink {
  id: string;
  title: string;
  icon: string | null;
  sectionName: string;
  notebookName: string;
}

/** "Linked from": pages that link here with [[…]]. Refreshes when the tree changes (any page saved). */
function Backlinks({ pageId, wsId }: { pageId: string; wsId: string }) {
  const [links, setLinks] = useState<Backlink[] | null>(null);
  const version = useStore((s) => s.tree.pages.reduce((m, p) => (p.updatedAt > m ? p.updatedAt : m), ''));
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      get<Backlink[]>(`/pages/${pageId}/backlinks`)
        .then((r) => !cancelled && setLinks(r))
        .catch(() => {});
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [pageId, version]);
  if (!links?.length) return null;
  return (
    <section className="backlinks" aria-label="Linked from">
      <h4 className="backlinks-title">
        Linked from {links.length} {links.length === 1 ? 'page' : 'pages'}
      </h4>
      {links.map((l) => (
        <Link key={l.id} to={`/w/${wsId}/p/${l.id}`} className="backlink">
          <span className="backlink-icon">{l.icon || <FileText size={15} />}</span>
          <span className="truncate">{l.title || 'Untitled'}</span>
          <span className="muted small truncate">
            {l.notebookName} › {l.sectionName}
          </span>
        </Link>
      ))}
    </section>
  );
}

/** Open-item count on a toolbar button; reads as "(3 open)" to screen readers. */
function PanelBadge({ n }: { n: number }) {
  return (
    <>
      <span className="sr-only"> ({n} open)</span>
      <span className="panel-badge" aria-hidden>
        {n > 99 ? '99+' : n}
      </span>
    </>
  );
}

interface SidePanelProps {
  pageId: string;
  tab: 'tasks' | 'comments';
  onTab: (t: 'tasks' | 'comments') => void;
  canComment: boolean;
  onClose: () => void;
  mobile: boolean;
}

/** Tasks and Comments for the page: a side panel on desktop, a dismissible bottom sheet on phones (#99). */
function PageSidePanel({ pageId, tab, onTab, canComment, onClose, mobile }: SidePanelProps) {
  const sheet = useRef<HTMLElement>(null);
  const drag = useRef<{ y: number; dy: number } | null>(null);
  useEffect(() => {
    if (!mobile) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobile, onClose]);

  // Swipe down on the sheet's header to close it.
  const onTouchStart = (e: ReactTouchEvent) => {
    if (mobile) drag.current = { y: e.touches[0].clientY, dy: 0 };
  };
  const onTouchMove = (e: ReactTouchEvent) => {
    if (!drag.current || !sheet.current) return;
    drag.current.dy = Math.max(0, e.touches[0].clientY - drag.current.y);
    sheet.current.style.transition = 'none';
    sheet.current.style.transform = `translateY(${drag.current.dy}px)`;
  };
  const onTouchEnd = () => {
    const d = drag.current;
    drag.current = null;
    if (!d || !sheet.current) return;
    sheet.current.style.transition = '';
    sheet.current.style.transform = '';
    if (d.dy > 60) onClose();
  };

  return (
    <>
      {mobile && <div className="page-sheet-backdrop" onClick={onClose} aria-hidden />}
      <aside ref={sheet} className={`page-panel ${mobile ? 'is-sheet' : ''}`} aria-label={tab === 'tasks' ? 'Tasks on this page' : 'Comments'}>
        <div className="panel-grab" onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd} onTouchCancel={onTouchEnd}>
          {mobile && <span className="sheet-handle" aria-hidden />}
          <div className="panel-head">
            <div className="segmented panel-tabs" role="tablist">
              <button role="tab" aria-selected={tab === 'tasks'} className={tab === 'tasks' ? 'is-active' : ''} onClick={() => onTab('tasks')}>
                <CircleCheck size={14} /> Tasks
              </button>
              <button role="tab" aria-selected={tab === 'comments'} className={tab === 'comments' ? 'is-active' : ''} onClick={() => onTab('comments')}>
                <MessageSquare size={14} /> Comments
              </button>
            </div>
            <button className="btn-ghost icon-btn" style={{ marginLeft: 'auto' }} onClick={onClose} title="Close panel" aria-label="Close panel">
              ×
            </button>
          </div>
        </div>
        {tab === 'tasks' ? <PageTasks pageId={pageId} /> : <CommentsPanel pageId={pageId} canComment={canComment} />}
      </aside>
    </>
  );
}

function PageTasks({ pageId }: { pageId: string }) {
  const all = useStore((s) => s.tasks);
  const shared = useShared((s) => s.tasks); // a page shared from another workspace (#98)
  const tasks = sortTasks([...Object.values(all), ...Object.values(shared).filter((t) => !all[t.id])].filter((t) => t.pageId === pageId));
  const open = tasks.filter((t) => t.status === 'open');
  const done = tasks.filter((t) => t.status === 'done');
  const [showDone, setShowDone] = useState(false);
  return (
    <>
      {tasks.length > 0 && (
        <div className="panel-progress">
          <span className="muted small">
            {done.length}/{tasks.length} done
          </span>
          <div className="progress">
            <div style={{ width: `${(done.length / tasks.length) * 100}%` }} />
          </div>
        </div>
      )}
      <div className="panel-body">
        {open.map((t) => (
          <TaskRow key={t.id} task={t} showSource={false} />
        ))}
        {!tasks.length && (
          <p className="muted small panel-empty">
            No tasks yet. Type <code>/task</code> in the note, or select text and press <code>{keyLabel(MOD, ENTER)}</code> to turn it into a task.
          </p>
        )}
        {done.length > 0 && (
          <button className="btn-ghost btn-sm" onClick={() => setShowDone((v) => !v)}>
            {showDone ? 'Hide' : 'Show'} {done.length} completed
          </button>
        )}
        {showDone && done.map((t) => <TaskRow key={t.id} task={t} showSource={false} />)}
      </div>
    </>
  );
}
