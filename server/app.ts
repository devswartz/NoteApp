// Builds the HTTP server: REST API, uploads, the built web app and WebSocket
// upgrades. server/index.ts starts it; tests start it on a random port.
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { WebSocketServer } from 'ws';
import { api, UPLOAD_DIR } from './routes/index.ts';
import { attachCollab } from './collab.ts';

export function createServer(opts: { serveWeb?: boolean } = {}) {
  const app = express();
  app.disable('x-powered-by');

  app.use('/api', api);
  app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '30d', immutable: true, fallthrough: false }));

  // In production the server also serves the built web app.
  const dist = path.resolve('dist');
  if (opts.serveWeb !== false && fs.existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/api|\/uploads|\/collab).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  attachCollab(wss);
  server.on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith('/collab')) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  return { app, server, wss };
}
