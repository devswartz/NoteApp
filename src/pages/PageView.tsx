import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { Editor } from '@tiptap/react';
import { ChevronRight, CircleCheck, MoreHorizontal, PanelRight, Trash2, Wifi, WifiOff, FolderInput, Plus, ListTodo } from 'lucide-react';
import { get, patch, del } from '../api.ts';
import { errorToast, toast, useStore } from '../store.ts';
import { NoteEditor, type PresenceUser, type SyncStatus } from '../editor/NoteEditor.tsx';
import { insertTaskAtEnd } from '../editor/TaskRef.tsx';
import { Avatar, Dropdown, MenuItem, MenuLabel, MenuSeparator, useIsMobile } from '../components/ui.tsx';
import { TaskRow } from '../components/TaskRow.tsx';
import { relativeTime } from '../lib/format.ts';
import { sortTasks } from '../lib/taskViews.ts';

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
  const [presence, setPresence] = useState<PresenceUser[]>([]);
  const [editor, setEditor] = useState<Editor | null>(null);
  const isMobile = useIsMobile();
  const [panelOpen, setPanelOpen] = useState(() => {
    try {
      return localStorage.getItem('noteapp.taskPanel') !== '0';
    } catch {
      return true;
    }
  });
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  useEffect(() => {
    let cancelled = false;
    setCanEdit(null);
    get<{ canEdit: boolean }>(`/pages/${pageId}`)
      .then((r) => !cancelled && setCanEdit(r.canEdit))
      .catch(() => !cancelled && setCanEdit(false));
    try {
      localStorage.setItem(`noteapp.lastPage.${wsId}`, pageId);
    } catch {
      /* ignore */
    }
    return () => {
      cancelled = true;
    };
  }, [pageId, wsId]);

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
      <div className="page-scroll">
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
            <span className={`sync sync-${status}`} title={status === 'live' ? 'Connected — changes sync live' : status === 'offline' ? 'Offline — edits are saved on this device and will sync when you reconnect' : 'Connecting…'}>
              {status === 'offline' ? <WifiOff size={14} /> : <Wifi size={14} />}
              <span className="sync-label">{status === 'live' ? 'Live' : status === 'offline' ? 'Offline' : 'Syncing'}</span>
            </span>
            {!canEdit && <span className="chip">View only</span>}
            <button
              className={`btn-ghost icon-btn ${panelOpen && !isMobile ? 'is-active' : ''}`}
              title="Tasks on this page"
              onClick={() => {
                setPanelOpen((o) => {
                  try {
                    localStorage.setItem('noteapp.taskPanel', o ? '0' : '1');
                  } catch {
                    /* ignore */
                  }
                  return !o;
                });
              }}
            >
              {isMobile ? <ListTodo size={18} /> : <PanelRight size={18} />}
            </button>
            {canEdit && <PageMenu pageId={pageId} wsId={wsId} />}
          </div>
        </header>

        <article className="page-article">
          <TitleInput key={`title-${pageId}`} pageId={pageId} initial={meta.title} canEdit={canEdit} onEnter={() => editor?.commands.focus('start')} />
          <div className="page-sub muted small">
            Edited {relativeTime(meta.updatedAt)}
            {updatedBy ? ` by ${updatedBy.id === user.id ? 'you' : updatedBy.name}` : ''}
          </div>
          <NoteEditor
            key={`editor-${pageId}`}
            pageId={pageId}
            user={user}
            canEdit={canEdit}
            onStatus={setStatus}
            onPresence={setPresence}
            onReady={onReady}
          />
          {canEdit && editor && (
            <button className="add-task-end" onClick={() => insertTaskAtEnd(editor, pageId)}>
              <Plus size={15} /> Add a task to this page
            </button>
          )}
        </article>
      </div>
      {panelOpen && <PageTasksPanel pageId={pageId} onClose={() => setPanelOpen(false)} mobile={isMobile} />}
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

function PageMenu({ pageId, wsId }: { pageId: string; wsId: string }) {
  const tree = useStore((s) => s.tree);
  const navigate = useNavigate();
  const current = tree.pages.find((p) => p.id === pageId);
  return (
    <Dropdown trigger={<MoreHorizontal size={18} />} buttonClass="btn-ghost icon-btn" title="Page options" placement="bottom-end" className="menu-scroll">
      <div className="menu">
        <MenuLabel>
          <FolderInput size={13} /> Move to section
        </MenuLabel>
        {tree.notebooks.map((n) => (
          <div key={n.id}>
            <div className="menu-group-title">{n.name}</div>
            {tree.sections
              .filter((s) => s.notebookId === n.id)
              .map((s) => (
                <MenuItem
                  key={s.id}
                  icon={<span className="dot" style={{ background: s.color }} />}
                  checked={current?.sectionId === s.id}
                  onSelect={() => {
                    if (current?.sectionId === s.id) return;
                    patch(`/pages/${pageId}`, { sectionId: s.id })
                      .then(() => toast(`Moved to ${n.name} › ${s.name}`))
                      .catch(errorToast);
                  }}
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
    </Dropdown>
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
