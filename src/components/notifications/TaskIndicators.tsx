// Small recurrence / reminder icons for a task row.
//   <TaskIndicators task={task} />
import { useEffect } from 'react';
import { Bell, Repeat } from 'lucide-react';
import { describeRecurrence } from '../../../shared/recurrence.ts';
import { useReminderIndex } from './reminderIndex.ts';
import type { Task } from '../../../shared/types.ts';
import './notifications.css';

export function TaskIndicators({ task }: { task: Pick<Task, 'id' | 'workspaceId' | 'status' | 'recurrence' | 'reminderAt' | 'dueDate'> }) {
  const next = useReminderIndex((s) => (s.wsId === task.workspaceId ? s.next[task.id] : undefined));
  const loadedWs = useReminderIndex((s) => s.wsId);
  useEffect(() => {
    // The first row of a workspace loads the index (once).
    if (loadedWs !== task.workspaceId) void useReminderIndex.getState().load(task.workspaceId);
  }, [loadedWs, task.workspaceId]);
  if (task.status !== 'open') return null;
  const reminderAt = next ?? (task.reminderAt && Date.parse(task.reminderAt) > Date.now() ? task.reminderAt : null);
  return (
    <>
      {/* With a due date, the due chip already shows the repeat icon. */}
      {task.recurrence && !task.dueDate && (
        <span className="task-ind muted" title={describeRecurrence(task.recurrence, task.dueDate)} aria-label={describeRecurrence(task.recurrence, task.dueDate)}>
          <Repeat size={12} />
        </span>
      )}
      {reminderAt && (
        <span
          className="task-ind muted"
          title={`Reminder ${new Date(reminderAt).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`}
          aria-label="Has reminder"
        >
          <Bell size={12} />
        </span>
      )}
    </>
  );
}
