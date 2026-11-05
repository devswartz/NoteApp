// The REST API: one router per area, registered here. To add an area, create
// server/routes/<area>.ts exporting a Router and add one line below.
import express, { Router } from 'express';
import { requireAuth } from '../auth.ts';
import { errorHandler } from '../http.ts';
import { authRoutes, publicAuthRoutes } from './auth.ts';
import { healthRoutes } from './health.ts';
import { publicWorkspaceRoutes, workspaceRoutes } from './workspaces.ts';
import { treeRoutes } from './tree.ts';
import { pageRoutes } from './pages.ts';
import { taskRoutes } from './tasks.ts';
import { searchRoutes } from './search.ts';
import { fileRoutes } from './files.ts';
import { publicReminderRoutes, reminderRoutes } from './reminders.ts';
import { commentRoutes } from './comments.ts';
import { notificationRoutes } from './notifications.ts';
import { activityRecorder, activityRoutes } from './activity.ts';

export { UPLOAD_DIR } from './files.ts';

export const api = Router();
const json = express.json({ limit: '1mb' });
api.use((req, res, next) => (req.path === '/uploads' ? next() : json(req, res, next)));

// No token needed.
api.use(healthRoutes);
api.use(publicAuthRoutes);
api.use(publicReminderRoutes);
api.use(publicWorkspaceRoutes);

// The live event stream (/api/events) is a WebSocket: see server/events.ts and server/app.ts.

// Everything below requires a signed-in user.
api.use(requireAuth);
api.use(activityRecorder); // activity feed: observes mutating requests, never blocks them
api.use(authRoutes);
api.use(workspaceRoutes);
api.use(treeRoutes);
api.use(pageRoutes);
api.use(taskRoutes);
api.use(searchRoutes);
api.use(fileRoutes);
api.use(reminderRoutes);
api.use(commentRoutes);
api.use(notificationRoutes);
api.use(activityRoutes);

api.use(errorHandler);
