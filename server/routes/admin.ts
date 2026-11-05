// Instance admin endpoints. Owner: Foundation.
import { Router } from 'express';
import fs from 'node:fs';
import { db } from '../db.ts';
import { isInstanceAdmin } from '../admin.ts';
import { requestStats } from '../requests.ts';
import { collabStats } from '../collab.ts';
import { eventStats } from '../events.ts';
import { DB_FILE, VERSION } from '../config.ts';
import { HttpError, h } from '../http.ts';

export const adminRoutes = Router();

adminRoutes.use('/admin', (req, _res, next) => next(isInstanceAdmin(req.user) ? undefined : new HttpError(403, 'Admins only')));

/** GET /admin/stats: basic health and usage numbers for whoever runs the server. */
adminRoutes.get(
  '/admin/stats',
  h(() => {
    const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { n: number }).n;
    const fileSize = (f: string) => {
      try {
        return fs.statSync(f).size;
      } catch {
        return 0;
      }
    };
    const mem = process.memoryUsage();
    return {
      version: VERSION,
      uptimeS: Math.round(process.uptime()),
      memoryMb: { rss: Math.round(mem.rss / 1e6), heapUsed: Math.round(mem.heapUsed / 1e6) },
      db: {
        bytes: DB_FILE === ':memory:' ? 0 : fileSize(DB_FILE) + fileSize(`${DB_FILE}-wal`),
        users: count('SELECT COUNT(*) AS n FROM users'),
        workspaces: count('SELECT COUNT(*) AS n FROM workspaces'),
        notebooks: count('SELECT COUNT(*) AS n FROM notebooks'),
        pages: count('SELECT COUNT(*) AS n FROM pages'),
        tasksOpen: count("SELECT COUNT(*) AS n FROM tasks WHERE status = 'open'"),
        tasksDone: count("SELECT COUNT(*) AS n FROM tasks WHERE status = 'done'"),
        // Live refresh tokens = signed-in devices (dates are ISO strings, so compare with an ISO now).
        activeSessions: count('SELECT COUNT(*) AS n FROM refresh_tokens WHERE revoked_at IS NULL AND used_at IS NULL AND expires_at > ?', new Date().toISOString()),
      },
      sockets: { collab: collabStats(), events: eventStats() },
      requests: requestStats(),
    };
  }),
);

/** GET /admin/me: lets the UI decide whether to show admin tools. */
adminRoutes.get('/admin/me', h(() => ({ admin: true })));
