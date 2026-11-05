import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.ts';
import type { User } from '../shared/types.ts';

function loadSecret(): string {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  // Persist a generated secret next to the database so sessions survive restarts.
  const file = path.resolve('data/.jwt-secret');
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    const s = crypto.randomBytes(48).toString('hex');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, s, { mode: 0o600 });
    return s;
  }
}
const SECRET = loadSecret();

export function signToken(userId: string): string {
  return jwt.sign({ sub: userId }, SECRET, { expiresIn: '30d' });
}

export function verifyToken(token: string | undefined | null): User | null {
  if (!token) return null;
  try {
    const { sub } = jwt.verify(token, SECRET) as { sub: string };
    return getUser(sub);
  } catch {
    return null;
  }
}

export function getUser(id: string): User | null {
  return (db.prepare('SELECT id, email, name, color FROM users WHERE id = ?').get(id) as User) ?? null;
}

declare module 'express-serve-static-core' {
  interface Request {
    user: User;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : (req.query.token as string | undefined);
  const user = verifyToken(token);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  req.user = user;
  next();
}
