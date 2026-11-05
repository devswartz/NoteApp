import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { Editor } from '@tiptap/react';
import { ChevronRight, CircleCheck, MoreHorizontal, PanelRight, Trash2, CloudOff, Check, Loader, FolderInput, Plus, ListTodo, Copy, SmilePlus, FileText, History, FileDown, FileUp, Printer, MoveHorizontal } from 'lucide-react';
import { get, patch, del, post } from '../api.ts';
import { errorToast, toast, useStore } from '../store.ts';
import { NoteEditor, type PresenceUser, type SaveState, type SyncStatus } from '../editor/NoteEditor.tsx';
import { IconPicker } from '../editor/IconPicker.tsx';
import { TemplatePicker } from '../editor/TemplatePicker.tsx';
import { VersionHistory } from '../editor/VersionHistory.tsx';
import { exportMarkdown, importMarkdown, printPage } from '../editor/exportPage.ts';
import { Outline, usePageSetting } from '../editor/Outline.tsx';
import { insertTaskAtEnd } from '../editor/TaskRef.tsx';
import { Avatar, Dropdown, MenuItem, MenuSeparator, useIsMobile } from '../components/ui.tsx';
import { TaskRow } from '../components/TaskRow.tsx';
import { relativeTime } from '../lib/format.ts';
import { sortTasks } from '../lib/taskViews.ts';
import { platform } from '../platform/index.ts';

export function PageView() {
  const { wsId, pageId } = useParams() as { wsId: string; pageId: string };
  const user = useStore((s) => s.user!);
  const meta = useStore((s) => s.tree.pages.find((p) => p.id === pageId));
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
  // The tasks panel remembers the user's choice; with none saved it starts open on
  // desktop and closed on phones (where it's a bottom sheet that would cover the note).
  const [panelOpen, setPanelOpen] = useState(() => {
    const saved = platform.kv.get('noteapp.taskPanel');
    if (saved === '1' || saved === '0') return saved === '1';
    return !window.matchMedia('(max-width: 760px)').matches;
  });
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  // Re-checked when your role changes (a live `workspaces` event reloads it), so a member
  // demoted to viewer goes read-only without a reload (BUG-2b).
  const role = useStore((s) => s.workspaces.find((w) => w.id === wsId)?.role);
  useEffect(() => setCanEdit(null), [pageId]);
  useEffect(() => {
    let cancelled = false;
    // Remember edit rights so a page opened offline stays editable (changes sync on reconnect).
    const key = `noteapp.canEdit.${user.id}.${pageId}`;
    get<{ canEdit: boolean }>(`/pages/${pageId}`)
      .then((r) => {
        platform.kv.set(key, r.canEdit ? '1' : '0');
        if (!cancelled) setCanEdit(r.canEdit);
      })
      .catch(() => !cancelled && setCanEdit(platform.kv.get(key) === '1'));
    platform.kv.set(`noteapp.lastPage.${wsId}`, pageId);
    return () => {
      cancelled = true;
    };
  }, [pageId, wsId, role]);

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

  if (treeLoaded && !meta) {
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
    <div className={`page-layout ${panelOpen && !isMobile ? 'with-panel' : ''}`}>
      <div className="page-scroll" ref={setScroller}>
        {editor && !fullWidth && !isMobile && <Outline editor={editor} scroller={scroller} />}
        <header className="page-topbar">
          <div className="crumbs">
            {notebook && (
              <span className="crumb">
                <span className="dot" style={{ background: notebook.color }} />
                {notebook.name}
              </span>
            )}
            <ChevronRight size={14} className="muted" />
            {section && <span className="crumb">{section.name}</span>}
          </div>
          <div className="topbar-right">
            <div className="presence">
              {presence.slice(0, 5).map((p) => (
                <Avatar key={p.id} user={p} size={24} title={`${p.name} is here`} />
              ))}
            </div>
            <SaveIndicator status={status} save={save} />
            {!canEdit && <span className="chip">View only</span>}
            <button
              className={`btn-ghost icon-btn ${panelOpen && !isMobile ? 'is-active' : ''}`}
              title="Tasks on this page"
              onClick={() => {
                setPanelOpen((o) => {
                  platform.kv.set('noteapp.taskPanel', o ? '0' : '1');
                  return !o;
                });
              }}
            >
              {isMobile ? <ListTodo size={18} /> : <PanelRight size={18} />}
            </button>
            {canEdit && <PageMenu pageId={pageId} wsId={wsId} editor={editor} onHistory={() => setHistoryOpen(true)} fullWidth={fullWidth} onFullWidth={setFullWidth} />}
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
      {panelOpen && <PageTasksPanel pageId={pageId} onClose={() => setPanelOpen(false)} mobile={isMobile} />}
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
  const remote = useStore((s) => s.tree.pages.find((p) => p.id === pageId)?.title ?? '');
  const focused = useRef(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!focused.current) setTitle(remote);
  }, [remote]);
  useEffect(() => {
    if (title === remote) return;
    const t = setTimeout(() => {
      patch(`/pages/${pageId}`, { title }).catch(errorToast);
      useStore.setState((s) => ({ tree: { ...s.tree, pages: s.tree.pages.map((p) => (p.id === pageId ? { ...p, title } : p)) } }));
    }, 400);
    return () => clearTimeout(t);
  }, [title]); // eslint-disable-line react-hooks/exhaustive-deps
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

/** The page "⋯" menu. Its items are a separate component so they're only built while the menu is open. */
function PageMenu(props: PageMenuProps) {
  return (
    <Dropdown trigger={<MoreHorizontal size={18} />} buttonClass="btn-ghost icon-btn" title="Page options" placement="bottom-end" className="menu-scroll">
      {() => <PageMenuItems {...props} />}
    </Dropdown>
  );
}

type PageMenuProps = {
  pageId: string;
  wsId: string;
  editor: Editor | null;
  onHistory: () => void;
  fullWidth: boolean;
  onFullWidth: (v: boolean) => void;
};

function PageMenuItems({ pageId, wsId, editor, onHistory, fullWidth, onFullWidth }: PageMenuProps) {
  const tree = useStore((s) => s.tree);
  const navigate = useNavigate();
  const current = tree.pages.find((p) => p.id === pageId);
  const [mode, setMode] = useState<'move' | 'copy'>('move');
  const sectionsOf = (notebookId: string) => tree.sections.filter((s) => s.notebookId === notebookId);
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
        <div className="menu page-menu">
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
          <MenuItem icon={<FileUp size={15} />} onSelect={() => editor && void importMarkdown(editor, pageId)}>
            Import Markdown…
          </MenuItem>
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
        </div>
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

function PageTasksPanel({ pageId, onClose, mobile }: { pageId: string; onClose: () => void; mobile: boolean }) {
  const all = useStore((s) => s.tasks);
  const tasks = sortTasks(Object.values(all).filter((t) => t.pageId === pageId));
  const open = tasks.filter((t) => t.status === 'open');
  const done = tasks.filter((t) => t.status === 'done');
  const [showDone, setShowDone] = useState(false);
  return (
    <aside className={`page-panel ${mobile ? 'is-sheet' : ''}`}>
      <div className="panel-head">
        <CircleCheck size={16} />
        <strong>Tasks on this page</strong>
        <span className="muted small">
          {done.length}/{tasks.length}
        </span>
        <button className="btn-ghost icon-btn" style={{ marginLeft: 'auto' }} onClick={onClose} title="Close panel">
          ×
        </button>
      </div>
      {tasks.length > 0 && (
        <div className="progress">
          <div style={{ width: `${(done.length / tasks.length) * 100}%` }} />
        </div>
      )}
      <div className="panel-body">
        {open.map((t) => (
          <TaskRow key={t.id} task={t} showSource={false} />
        ))}
        {!tasks.length && (
          <p className="muted small panel-empty">
            No tasks yet. Type <code>[]</code> in the note, or select text and press <code>⌘↵</code> to turn it into a task.
          </p>
        )}
        {done.length > 0 && (
          <button className="btn-ghost btn-sm" onClick={() => setShowDone((v) => !v)}>
            {showDone ? 'Hide' : 'Show'} {done.length} completed
          </button>
        )}
        {showDone && done.map((t) => <TaskRow key={t.id} task={t} showSource={false} />)}
      </div>
    </aside>
  );
}
