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
import { trashRoutes } from './trash.ts';
import { taskRoutes } from './tasks.ts';
import { teamRoutes } from './teams.ts';
import { searchRoutes } from './search.ts';
import { fileRoutes } from './files.ts';
import { publicReminderRoutes, reminderRoutes } from './reminders.ts';
import { commentRoutes } from './comments.ts';
import { notificationRoutes } from './notifications.ts';
import { activityRecorder, activityRoutes } from './activity.ts';
import { templateRoutes } from './templates.ts';
import { feedbackRoutes } from './feedback.ts';
import { oauthApiRoutes } from '../oauth/routes.ts';

import { adminRoutes } from './admin.ts';
import { exportRoutes } from './export.ts';
import { oneNoteGate, oneNoteRoutes, publicOneNoteRoutes } from './onenote.ts';

export { UPLOAD_DIR } from './files.ts';

export const api = Router();
// JSON bodies are small: the largest field is a task description (50 000 chars, up to ~200 KB of UTF-8). Uploads and imports are raw, not JSON.
const json = express.json({ limit: '512kb' });
api.use((req, res, next) => (req.path === '/uploads' || req.path === '/workspaces/import' || req.path === '/client-errors' ? next() : json(req, res, next))); // /client-errors parses its own, much smaller, body

// No token needed.
api.use(healthRoutes);
api.use(clientErrorRoutes); // POST /client-errors: browser error reports, logged only
api.use(authRateLimit); // 429 + Retry-After on login/sign-up/refresh/invite endpoints
api.use(publicAuthRoutes);
api.use(publicReminderRoutes);
api.use(publicWorkspaceRoutes);
api.use('/import/onenote', oneNoteGate); // OneNote import (#117): 404 for everyone unless MS_CLIENT_ID + MS_CLIENT_SECRET are set
api.use(publicOneNoteRoutes); // the browser's OAuth redirects (one-time ticket, then state + flow cookie)

// The live event stream (/api/events) is a WebSocket: see server/events.ts and server/app.ts.

// Everything below requires a signed-in user.
api.use(requireAuth);
api.use(requireVerifiedEmail); // unverified users get 403 email_unverified on everything below except GET /me and POST /auth/resend-verification
api.use(activityRecorder); // activity feed: observes mutating requests, never blocks them
api.use(authRoutes);
api.use(oneNoteRoutes);
api.use(exportRoutes); // before workspaceRoutes: /workspaces/import must not hit /workspaces/:id
api.use(workspaceRoutes);
api.use(treeRoutes);
api.use(pageRoutes);
api.use(trashRoutes);
api.use(taskRoutes);
api.use(teamRoutes); // tags, teams, saved task views
api.use(searchRoutes);
api.use(fileRoutes);
api.use(reminderRoutes);
api.use(commentRoutes);
api.use(notificationRoutes);
api.use(activityRoutes);
api.use(templateRoutes);
api.use(feedbackRoutes);
api.use(oauthApiRoutes); // AI connectors: consent decisions and Settings → Connected apps (server/oauth/routes.ts)

api.use(adminRoutes);

api.use(errorHandler);
