// The REST API: one router per area, registered here. To add an area, create
// server/routes/<area>.ts exporting a Router and add one line below.
import express, { Router } from 'express';
import { requireAuth } from '../auth.ts';
import { errorHandler } from '../http.ts';
import { authRoutes, publicAuthRoutes } from './auth.ts';
import { eventRoutes } from './events.ts';
import { workspaceRoutes } from './workspaces.ts';
import { treeRoutes } from './tree.ts';
import { pageRoutes } from './pages.ts';
import { taskRoutes } from './tasks.ts';
import { searchRoutes } from './search.ts';
import { fileRoutes } from './files.ts';

export { UPLOAD_DIR } from './files.ts';

export const api = Router();
const json = express.json({ limit: '1mb' });
api.use((req, res, next) => (req.path === '/uploads' ? next() : json(req, res, next)));

// No token needed.
api.use(publicAuthRoutes);

// Everything below requires a signed-in user.
api.use(requireAuth);
api.use(authRoutes);
api.use(eventRoutes);
api.use(workspaceRoutes);
api.use(treeRoutes);
api.use(pageRoutes);
api.use(taskRoutes);
api.use(searchRoutes);
api.use(fileRoutes);

api.use(errorHandler);
