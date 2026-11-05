// Task REST endpoints (rules live in server/tasks.ts). Owner: Tasks & Dashboard.
import { Router } from 'express';
import { requireRole } from '../access.ts';
import { createTask, deleteTask, listCompleted, listTasks, updateTask } from '../tasks.ts';
import { HttpError, h, param } from '../http.ts';

export const taskRoutes = Router();

taskRoutes.get(
  '/workspaces/:id/tasks',
  h((req) => {
    requireRole(param(req, 'id'), req.user.id, 'viewer');
    return listTasks(param(req, 'id'), req.user.id);
  }),
);

taskRoutes.get(
  '/workspaces/:id/tasks/completed',
  h((req) => {
    requireRole(param(req, 'id'), req.user.id, 'viewer');
    return listCompleted(param(req, 'id'), req.user.id, (req.query.before as string) || null);
  }),
);

// Empty titles are allowed: typing "[] " in a note creates the task before its title is typed.
taskRoutes.post(
  '/workspaces/:id/tasks',
  h((req) => {
    const title = req.body.title ?? '';
    if (typeof title !== 'string' || title.length > 1000) throw new HttpError(400, 'Invalid title');
    return createTask(req.user.id, param(req, 'id'), { ...req.body, title });
  }),
);

taskRoutes.patch('/tasks/:id', h((req) => updateTask(req.user.id, param(req, 'id'), req.body)));

taskRoutes.delete(
  '/tasks/:id',
  h((req) => {
    deleteTask(req.user.id, param(req, 'id'));
    return { ok: true };
  }),
);
