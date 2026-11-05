// File uploads (images and attachments). Owner: Editor & Notes.
import express, { Router } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError, h } from '../http.ts';

export const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR ?? 'data/uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const fileRoutes = Router();

fileRoutes.post(
  '/uploads',
  express.raw({ type: () => true, limit: '25mb' }),
  h((req) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'Empty upload');
    const original = decodeURIComponent(String(req.headers['x-filename'] ?? 'file'));
    const ext = path.extname(original).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
    // Unguessable name; files are served without auth so links can be embedded in notes.
    const name = crypto.randomBytes(16).toString('hex') + ext;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), req.body);
    return { url: `/uploads/${name}`, name: original, size: req.body.length };
  }),
);
