// Builds the HTTP server: REST API, uploads, the built web app and both
// WebSocket endpoints, all on one port (docs/DEPLOY_CONTRACT.md):
//   /api/*        REST
//   /api/events   WebSocket: live task/tree/member events (server/events.ts)
//   /collab/<id>  WebSocket: Yjs sync for one page (server/collab.ts)
//   /uploads/*    uploaded files
//   /oauth/*      OAuth authorization server for AI connectors (server/oauth/routes.ts)
//   /mcp          the AI connector: a remote MCP server (server/mcp/)
//   everything else: the web app (dist/), with index.html as the SPA fallback
// server/index.ts starts it; tests start it on a random port.
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { WebSocketServer } from 'ws';
import { api } from './routes/index.ts';
import { serveUploads } from './routes/files.ts';
import { wellKnownRoutes } from './wellKnown.ts';
import { oauthRoutes } from './oauth/routes.ts';
import { errorHandler } from './http.ts';
import { MAX_SYNC_MESSAGE_BYTES, attachCollab } from './collab.ts';
import { attachEvents } from './events.ts';
import { handleProtocols } from './auth.ts';
import { securityHeaders } from './security.ts';
import { requestLog } from './requests.ts';
import { testHookRoutes } from './testHooks.ts';
import { testHooksEnabled } from './verification.ts';
import { mcpRoutes } from './mcp/index.ts';

export function createServer(opts: { serveWeb?: boolean } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback'); // behind the Cloudflare tunnel / reverse proxy
  app.use(securityHeaders); // CSP, HSTS, framing, referrer, permissions (server/security.ts)

  // The API uses bearer tokens, never cookies, so any origin may call it
  // (native shells run on tauri:// and capacitor:// origins).
  app.use('/api', requestLog);
  app.use('/api', (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id');
    if (req.method !== 'OPTIONS') return next();
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Filename, X-Request-Id');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.status(204).end();
  });
  if (testHooksEnabled()) app.use('/api/__test', testHookRoutes); // e2e only; never in production (server/verification.ts)
  app.use('/api', api);
  app.use('/.well-known', wellKnownRoutes()); // universal / app links for the mobile apps (docs/MOBILE.md), OAuth metadata
  app.use('/oauth', requestLog, oauthRoutes(), errorHandler); // AI connector authorization server (server/oauth/routes.ts); /oauth/consent is a web app page
  app.use('/uploads', serveUploads); // nosniff + sandbox CSP + attachment disposition (routes/files.ts)
  app.use('/mcp', requestLog, mcpRoutes); // AI connector: OAuth bearer tokens only (server/mcp/index.ts)

  // In production the server also serves the built web app.
  const dist = path.resolve('dist');
  if (opts.serveWeb !== false && fs.existsSync(dist)) {
    // Hashed assets can be cached forever; index.html and sw.js must revalidate.
    app.use('/assets', express.static(path.join(dist, 'assets'), { maxAge: '1y', immutable: true }));
    app.use(express.static(dist, { index: false, maxAge: 0 }));
    app.get(/^(?!\/api\/|\/uploads\/|\/collab\/|\/mcp(\/|$)).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  const server = http.createServer(app);
  const collab = new WebSocketServer({ noServer: true, maxPayload: MAX_SYNC_MESSAGE_BYTES + 1024, handleProtocols });
  const events = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, handleProtocols });
  attachCollab(collab);
  attachEvents(events);
  server.on('upgrade', (req, socket, head) => {
    // A malformed request target must refuse that one socket, not throw out of the event handler (an
    // uncaught exception takes the whole server down, and this runs before any authentication).
    try {
      const pathname = new URL(req.url ?? '/', 'http://x').pathname;
      const wss = pathname === '/api/events' ? events : pathname.startsWith('/collab/') ? collab : null;
      if (!wss) return socket.destroy();
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } catch {
      socket.destroy();
    }
  });
  return { app, server, collab, events };
}
