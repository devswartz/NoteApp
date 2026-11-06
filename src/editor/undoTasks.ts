// Undoing a convert-to-task (or a "[] " task) shouldn't leave a task behind.
//
// Normally a taskRef that disappears from a note makes its task standalone (never
// deleted silently, see ARCHITECTURE.md). But when an *undo* removes a taskRef that
// this session created, the user is taking back their own action: the task is deleted.
// A redo brings the taskRef back and recreates the task with the same id and fields.
// Once an ordinary edit removes the taskRef, the usual rule applies again, even to a later
// redo (UndoTaskTracker in taskRefIds.ts).
import { Extension } from '@tiptap/core';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { createTask, deleteTask, toggleTask, useStore } from '../store.ts';
import type { Task } from '../../shared/types.ts';
import { UndoTaskTracker, taskRefsDeletedBy, undoRedoChanges } from './taskRefIds.ts';

const tracker = new UndoTaskTracker();
/** Snapshots of tasks deleted by an undo, so a redo can recreate them exactly. */
const snapshots = new Map<string, Task>();

/** Tasks created from this editor session (convert, "[] ", insert, Enter in a task). */
export function markCreatedHere(taskId: string) {
  tracker.created(taskId);
}

export const UndoTasks = Extension.create({
  name: 'undoTasks',
  onTransaction({ transaction: tr }) {
    if (!tr.docChanged) return;
    const meta = tr.getMeta(ySyncPluginKey) as { isUndoRedoOperation?: boolean; isChangeOrigin?: boolean } | undefined;
    if (!meta?.isUndoRedoOperation) {
      // An ordinary edit (or a collaborator's) that removes a taskRef ends its undo eligibility.
      if (!tracker.hasEligible()) return;
      // Remote changes arrive as one whole-document replacement, so compare the documents;
      // local edits only need their deleted ranges scanned.
      tracker.editRemoved(meta?.isChangeOrigin ? undoRedoChanges(tr.before, tr.doc).removed : taskRefsDeletedBy(tr));
      return;
    }
    const changes = undoRedoChanges(tr.before, tr.doc);
    const { remove, recreate } = tracker.undoRedo(changes.removed, changes.added);
    for (const id of remove) {
      const task = useStore.getState().tasks[id];
      if (!task) continue;
      snapshots.set(id, task);
      void deleteTask(id);
    }
    for (const id of recreate) {
      const t = snapshots.get(id);
      if (!t) continue;
      snapshots.delete(id);
      void createTask({
        id,
        title: t.title,
        description: t.description,
        priority: t.priority,
        dueDate: t.dueDate,
        dueTime: t.dueTime,
        recurrence: t.recurrence,
        reminderAt: t.reminderAt,
        assigneeId: t.assigneeId,
        pageId: t.pageId,
      }).then((created) => {
        if (created && t.status === 'done') toggleTask(id);
      });
    }
  },
});
