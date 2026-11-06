// Test-only HTTP hooks for the e2e suite (tests/e2e/23-*): read the mail "outbox" of a server that has no
// SMTP. Mounted by server/app.ts ONLY when testHooksEnabled() (E2E_TEST_HOOKS=1 and NODE_ENV not
// "production"); the check also runs on every request, so flipping NODE_ENV can't leave it exposed.
import { Router } from 'express';
import { outbox } from './mail.ts';
import { testHooksEnabled } from './verification.ts';

export const testHookRoutes = Router();

testHookRoutes.use((_req, res, next) => (testHooksEnabled() ? next() : void res.status(404).json({ error: 'Not found' })));

// GET /api/__test/outbox?to=<address> → messages "sent" to that address (newest last).
testHookRoutes.get('/outbox', (req, res) => {
  const to = String(req.query.to ?? '').toLowerCase();
  res.json(outbox.filter((m) => !to || m.to.toLowerCase() === to));
});
