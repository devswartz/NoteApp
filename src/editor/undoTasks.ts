// What happens to a task when its line leaves a note.
//
// Deleting a task's line from a note deletes the task (Devon, 2026-11-17: "Deleting them on the
// note should absolutely delete them from tasks"): a selection deleted, Backspace, Delete.
// The tasks are kept in this tab (deleteTasksRemovedFromPage) so Ctrl+Z, which brings the line
// back, brings the task back too, with the same id and fields: the task line's node view sees a
// task this tab deleted and recreates it (restoreDeletedFromPage), whichever undo put it back
// (this editor's, the page's, or a text box's Undo). A redo that removes it again deletes it again.
//
// Not a delete: Cut (the line is on its way to be pasted, here or in another note; never pasted,
// the task becomes standalone when the note is saved, see syncPageTasks), a drag-and-drop move,
// an edit that only moves the line within the note, and a collaborator's edit (their editor
// deletes the task; this one only follows).
//
// Undoing a convert-to-task (or a "[] " task) shouldn't leave a task behind either: an undo that
// removes a taskRef this session created deletes the task, and a redo recreates it
// (UndoTaskTracker in taskRefIds.ts).
import { Extension } from '@tiptap/core';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { createTask, deleteTask, toggleTask, useStore } from '../store.ts';
import { deleteTasksRemovedFromPage, wasRestoredFromPage } from '../store/tasks.ts';
import type { Task } from '../../shared/types.ts';
import { UndoTaskTracker, taskRefIds, taskRefsDeletedBy, undoRedoChanges } from './taskRefIds.ts';

const tracker = new UndoTaskTracker();
/** Snapshots of tasks deleted by an undo, so a redo can recreate them exactly. */
const snapshots = new Map<string, Task>();

/** Tasks created from this editor session (convert, "[] ", insert, Enter in a task). */
export function markCreatedHere(taskId: string) {
  tracker.created(taskId);
}

/** Transactions that take task lines out of the note without deleting them: they're being moved. */
const MOVES = new Set(['cut', 'drop']);

export const UndoTasks = Extension.create({
  name: 'undoTasks',
  onTransaction({ transaction: tr }) {
    if (!tr.docChanged) return;
    const meta = tr.getMeta(ySyncPluginKey) as { isUndoRedoOperation?: boolean; isChangeOrigin?: boolean } | undefined;
    if (!meta?.isUndoRedoOperation) {
      // A collaborator's change (or the server's): their editor deals with their tasks.
      if (meta?.isChangeOrigin) {
        if (tracker.hasEligible()) tracker.editRemoved(undoRedoChanges(tr.before, tr.doc).removed);
        return;
      }
      const deleted = taskRefsDeletedBy(tr);
      if (!deleted.size) return;
      // An ordinary edit that removes a taskRef ends its undo eligibility.
      tracker.editRemoved(deleted);
      if (MOVES.has(tr.getMeta('uiEvent') as string)) return;
      // Lines moved within the note (or put back by the same transaction) are still there.
      const still = taskRefIds(tr.doc);
      const gone = [...deleted].filter((id) => !still.has(id));
      if (gone.length && this.editor.isEditable) deleteTasksRemovedFromPage(gone);
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
    // A redo of a deleted line: a task brought back with it by the undo goes again.
    const again = changes.removed.filter((id) => !remove.includes(id) && wasRestoredFromPage(id));
    if (again.length) deleteTasksRemovedFromPage(again);
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
