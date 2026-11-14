// Task REST endpoints (rules live in server/tasks.ts). Owner: Tasks & Dashboard.
import { Router } from 'express';
import * as Y from 'yjs';
import { pageAccess, requireRole, taskVisible } from '../access.ts';
import { createTask, deleteTask, getTask, listCompleted, listTasks, updateTask } from '../tasks.ts';
import { pageDocState } from '../collab.ts';
import { findTaskElement, notesMarkdown } from '../taskNotes.ts';
import { HttpError, h, param } from '../http.ts';
import { viewTask, viewTasks } from '../locks.ts';

export const taskRoutes = Router();

taskRoutes.get(
  '/workspaces/:id/tasks',
  h((req) => {
    requireRole(param(req, 'id'), req.user.id, 'viewer');
    return viewTasks(listTasks(param(req, 'id'), req.user.id), req.user.id); // tasks on a locked page: "Locked task" until unlocked
  }),
);

taskRoutes.get(
  '/workspaces/:id/tasks/completed',
  h((req) => {
    requireRole(param(req, 'id'), req.user.id, 'viewer');
    return viewTasks(listCompleted(param(req, 'id'), req.user.id, (req.query.before as string) || null), req.user.id);
  }),
);

// Empty titles are allowed: inserting a task in a note (/task) creates it before its title is typed.
taskRoutes.post(
  '/workspaces/:id/tasks',
  h((req) => {
    const title = req.body.title ?? '';
    if (typeof title !== 'string' || title.length > 1000) throw new HttpError(400, 'Invalid title');
    return viewTask(createTask(req.user.id, param(req, 'id'), { ...req.body, title }), req.user.id);
  }),
);

taskRoutes.patch('/tasks/:id', h((req) => viewTask(updateTask(req.user.id, param(req, 'id'), req.body), req.user.id)));

// The notes written under the task in its page (read-only, for the task panel's "From the note"): read from the page
// as it is now, the live room's copy when it's open. `markdown` is '' when the task has no notes or isn't on a page.
taskRoutes.get(
  '/tasks/:id/notes',
  h((req) => {
    const id = param(req, 'id');
    const userId = req.user.id;
    const task = getTask(id);
    if (!task || !taskVisible(id, userId)) throw new HttpError(404, 'Task not found');
    if (!task.pageId || !pageAccess(task.pageId, userId)) return { markdown: '' };
    const state = pageDocState(task.pageId);
    if (!state) return { markdown: '' };
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, state);
      const el = findTaskElement(doc, id);
      if (!el) return { markdown: '' };
      // Subtasks in the notes are left out: the panel lists them under Subtasks.
      return { markdown: notesMarkdown(el, () => null) };
    } finally {
      doc.destroy();
    }
  }),
);

taskRoutes.delete(
  '/tasks/:id',
  h((req) => {
    deleteTask(req.user.id, param(req, 'id'));
    return { ok: true };
  }),
);
