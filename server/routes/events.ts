// Live event stream. Owner: Collaboration & Access.
import { Router } from 'express';
import { addClient } from '../events.ts';

export const eventRoutes = Router();

// Server-sent events stream (EventSource can't set headers, so the token comes via query).
eventRoutes.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  addClient(req.user.id, res);
});
