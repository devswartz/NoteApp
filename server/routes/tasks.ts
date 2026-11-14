// Task REST endpoints (rules live in server/tasks.ts). Owner: Tasks & Dashboard.
import { Router } from 'express';
import { requireRole } from '../access.ts';
import { createTask, deleteTask, listCompleted, listTasks, updateTask } from '../tasks.ts';
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

taskRoutes.delete(
  '/tasks/:id',
  h((req) => {
    deleteTask(req.user.id, param(req, 'id'));
    return { ok: true };
  }),
);
