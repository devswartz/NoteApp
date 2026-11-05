// Floating action bar for the selected task rows (Ctrl/⌘-click or Shift-click to select).
import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { CalendarDays, CheckCircle2, Flag, RotateCcw, Trash2, UserRound, X } from 'lucide-react';
import { useStore } from '../../store.ts';
import { bulkDelete, bulkUpdate } from '../../store/tasks.ts';
import { Dropdown } from '../../components/ui.tsx';
import { AssigneeMenu, DueMenu, PriorityMenu } from '../../components/TaskControls.tsx';
import { selection, useSelection } from './selection.ts';

export function BulkBar() {
  const ids = useSelection((s) => s.ids);
  const tasks = useStore((s) => s.tasks);
  const canEdit = useStore((s) => s.workspaces.find((w) => w.id === s.wsId)?.role !== 'viewer');
  const location = useLocation();

  // Selection belongs to one view; clear it on navigation, prune it when rows disappear.
  useEffect(() => selection.clear(), [location.pathname]);
  useEffect(() => {
    const t = setTimeout(() => selection.prune(), 0);
    return () => clearTimeout(t);
  }, [tasks]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest('input, textarea, select, [contenteditable="true"]')) return;
      const s = useStore.getState();
      if (s.paletteOpen || s.quickAdd || s.taskDetailId) return;
      if (e.key === 'Escape' && useSelection.getState().ids.size) {
        e.preventDefault();
        selection.clear();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a' && el?.closest('.tasks-page, body')) {
        e.preventDefault();
        selection.selectAll();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!ids.size || !canEdit) return null;
  const list = [...ids];
  const allDone = list.every((id) => tasks[id]?.status === 'done');
  const done = () => selection.clear();
  return (
    <div className="bulk-bar" role="toolbar" aria-label="Bulk actions">
      <span className="bulk-count">{ids.size} selected</span>
      {allDone ? (
        <button className="btn-ghost btn-sm" onClick={() => (void bulkUpdate(list, { status: 'open' }, 'Reopened'), done())}>
          <RotateCcw size={15} /> Reopen
        </button>
      ) : (
        <button className="btn-ghost btn-sm" onClick={() => (void bulkUpdate(list, { status: 'done' }, 'Completed'), done())}>
          <CheckCircle2 size={15} /> Complete
        </button>
      )}
      <Dropdown buttonClass="btn-ghost btn-sm" trigger={<><CalendarDays size={15} /> Date</>} title="Reschedule" placement="top-start">
        <DueMenu value={null} onChange={(dueDate) => void bulkUpdate(list, { dueDate }, 'Rescheduled')} />
      </Dropdown>
      <Dropdown buttonClass="btn-ghost btn-sm" trigger={<><UserRound size={15} /> Assign</>} title="Assign" placement="top-start">
        <AssigneeMenu value={null} onChange={(assigneeId) => void bulkUpdate(list, { assigneeId }, 'Reassigned')} />
      </Dropdown>
      <Dropdown buttonClass="btn-ghost btn-sm" trigger={<><Flag size={15} /> Priority</>} title="Set priority" placement="top-start">
        <PriorityMenu value={4} onChange={(priority) => void bulkUpdate(list, { priority }, 'Priority set')} />
      </Dropdown>
      <button
        className="btn-ghost btn-sm danger"
        title="Delete"
        onClick={() => {
          if (!confirm(`Delete ${ids.size} task${ids.size === 1 ? '' : 's'}? Tasks in notes are removed from them too.`)) return;
          void bulkDelete(list);
          done();
        }}
      >
        <Trash2 size={15} />
      </button>
      <button className="btn-ghost icon-btn" title="Clear selection (Esc)" onClick={done}>
        <X size={16} />
      </button>
    </div>
  );
}
