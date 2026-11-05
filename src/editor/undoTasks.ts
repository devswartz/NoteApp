// Undoing a convert-to-task (or a "[] " task) shouldn't leave a task behind.
//
// Normally a taskRef that disappears from a note makes its task standalone (never
// deleted silently, see ARCHITECTURE.md). But when an *undo* removes a taskRef that
// this session created, the user is taking back their own action: the task is deleted.
// A redo brings the taskRef back and recreates the task with the same id and fields.
import { Extension } from '@tiptap/core';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { createTask, deleteTask, toggleTask, useStore } from '../store.ts';
import type { Task } from '../../shared/types.ts';
import { undoRedoChanges } from './taskRefIds.ts';

/** Tasks created from this editor session (convert, "[] ", insert, Enter in a task). */
const createdHere = new Set<string>();
/** Tasks deleted by an undo, kept so a redo can bring them back. */
const undone = new Map<string, Task>();

export function markCreatedHere(taskId: string) {
  createdHere.add(taskId);
}

export const UndoTasks = Extension.create({
  name: 'undoTasks',
  onTransaction({ transaction: tr }) {
    const meta = tr.getMeta(ySyncPluginKey) as { isUndoRedoOperation?: boolean } | undefined;
    if (!meta?.isUndoRedoOperation || !tr.docChanged) return;
    const { removed, added } = undoRedoChanges(tr.before, tr.doc);
    for (const id of removed) {
      if (!createdHere.has(id)) continue; // someone else's or an older task: keep the usual rule
      const task = useStore.getState().tasks[id];
      if (!task) continue;
      undone.set(id, task);
      void deleteTask(id);
    }
    for (const id of added) {
      const t = undone.get(id);
      if (!t) continue;
      undone.delete(id);
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
