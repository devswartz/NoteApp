// The REST API: one router per area, registered here. To add an area, create
// server/routes/<area>.ts exporting a Router and add one line below.
import express, { Router } from 'express';
import { requireAuth, requireVerifiedEmail } from '../auth.ts';
import { errorHandler } from '../http.ts';
import { authRateLimit } from '../ratelimit.ts';
import { authRoutes, publicAuthRoutes } from './auth.ts';
import { healthRoutes } from './health.ts';
import { clientErrorRoutes } from './clientErrors.ts';
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
import { templateRoutes } from './templates.ts';

import { adminRoutes } from './admin.ts';

export { UPLOAD_DIR } from './files.ts';

export const api = Router();
// JSON bodies are small: the largest field is a task description (50 000 chars, up to ~200 KB of UTF-8). Uploads are raw, not JSON.
const json = express.json({ limit: '512kb' });
api.use((req, res, next) => (req.path === '/uploads' || req.path === '/client-errors' ? next() : json(req, res, next))); // /client-errors parses its own, much smaller, body

// No token needed.
api.use(healthRoutes);
api.use(clientErrorRoutes); // POST /client-errors: browser error reports, logged only
api.use(authRateLimit); // 429 + Retry-After on login/sign-up/refresh/invite endpoints
api.use(publicAuthRoutes);
api.use(publicReminderRoutes);
api.use(publicWorkspaceRoutes);

// The live event stream (/api/events) is a WebSocket: see server/events.ts and server/app.ts.

// Everything below requires a signed-in user.
api.use(requireAuth);
api.use(requireVerifiedEmail); // unverified users get 403 email_unverified on everything below except GET /me and POST /auth/resend-verification
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
api.use(templateRoutes);

api.use(adminRoutes);

api.use(errorHandler);
