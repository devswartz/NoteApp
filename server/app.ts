// Builds the HTTP server: REST API, uploads, the built web app and both
// WebSocket endpoints, all on one port (docs/DEPLOY_CONTRACT.md):
//   /api/*        REST
//   /api/events   WebSocket: live task/tree/member events (server/events.ts)
//   /collab/<id>  WebSocket: Yjs sync for one page (server/collab.ts)
//   /uploads/*    uploaded files
//   everything else: the web app (dist/), with index.html as the SPA fallback
// server/index.ts starts it; tests start it on a random port.
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { WebSocketServer } from 'ws';
import { api } from './routes/index.ts';
import { serveUploads } from './routes/files.ts';
import { attachCollab } from './collab.ts';
import { attachEvents } from './events.ts';
import { handleProtocols } from './auth.ts';

export function createServer(opts: { serveWeb?: boolean } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback'); // behind the Cloudflare tunnel / reverse proxy

  // The API uses bearer tokens, never cookies, so any origin may call it
  // (native shells run on tauri:// and capacitor:// origins).
  app.use('/api', (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method !== 'OPTIONS') return next();
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Filename');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.status(204).end();
  });
  app.use('/api', api);
  app.use('/uploads', serveUploads); // nosniff + sandbox CSP + attachment disposition (routes/files.ts)

  // In production the server also serves the built web app.
  const dist = path.resolve('dist');
  if (opts.serveWeb !== false && fs.existsSync(dist)) {
    // Hashed assets can be cached forever; index.html and sw.js must revalidate.
    app.use('/assets', express.static(path.join(dist, 'assets'), { maxAge: '1y', immutable: true }));
    app.use(express.static(dist, { index: false, maxAge: 0 }));
    app.get(/^(?!\/api\/|\/uploads\/|\/collab\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  const server = http.createServer(app);
  const collab = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024, handleProtocols });
  const events = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, handleProtocols });
  attachCollab(collab);
  attachEvents(events);
  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname;
    const wss = pathname === '/api/events' ? events : pathname.startsWith('/collab/') ? collab : null;
    if (!wss) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  return { app, server, collab, events };
}
