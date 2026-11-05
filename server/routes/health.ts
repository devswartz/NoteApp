// Health check for the container/proxy (docs/DEPLOY_CONTRACT.md). No auth.
import { Router } from 'express';
import { db } from '../db.ts';
import { VERSION } from '../config.ts';

export const healthRoutes = Router();

healthRoutes.get('/health', (_req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ ok: true, version: VERSION });
  } catch {
    res.status(503).json({ ok: false, version: VERSION });
  }
});
