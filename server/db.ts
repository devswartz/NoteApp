import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const file = process.env.DB_FILE ?? path.resolve('data/noteapp.db');
if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });

export const db = new Database(file);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export const newId = () => crypto.randomUUID();
export const now = () => new Date().toISOString();

// Schema migrations live in server/migrations/NNN-name.sql and are applied in
// order. The number of the last applied migration is kept in PRAGMA user_version.
const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  const list = fs
    .readdirSync(dir)
    .filter((f) => /^\d{3}-[\w-]+\.sql$/.test(f))
    .map((f) => ({ version: Number(f.slice(0, 3)), name: f, sql: fs.readFileSync(path.join(dir, f), 'utf8') }))
    .sort((a, b) => a.version - b.version);
  list.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`Migrations must be numbered 001, 002, … without gaps or duplicates (found ${m.name})`);
  });
  return list;
}

export function migrate(database: Database.Database, migrations = loadMigrations()) {
  const version = database.pragma('user_version', { simple: true }) as number;
  for (const m of migrations) {
    if (m.version <= version) continue;
    database.transaction(() => {
      database.exec(m.sql);
      database.pragma(`user_version = ${m.version}`);
    })();
  }
}

migrate(db);

export const COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#14b8a6'];
export const pickColor = () => COLORS[Math.floor(Math.random() * COLORS.length)];
