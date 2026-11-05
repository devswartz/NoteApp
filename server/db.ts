import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { DB_FILE } from './config.ts';

if (DB_FILE !== ':memory:') fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

export const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export const newId = () => crypto.randomUUID();
export const now = () => new Date().toISOString();

// Schema migrations live in server/migrations/NNN-name.sql. Each one is
// recorded in schema_migrations when applied; any not yet applied run in
// numeric order at startup, one transaction each. Numbers must be unique but
// may have gaps, because numbers are reserved per PR and can merge out of
// order (a later-numbered migration landing first doesn't make an earlier one
// get skipped). So migrations must not depend on a higher-numbered one.
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
  for (let i = 1; i < list.length; i++) {
    if (list[i].version === list[i - 1].version)
      throw new Error(`Two migrations share number ${list[i].version}: ${list[i - 1].name} and ${list[i].name}. Renumber one.`);
  }
  return list;
}

export function migrate(database: Database.Database, migrations = loadMigrations()) {
  const fresh = !database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  database.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  if (fresh) {
    // Databases from before this table tracked progress in user_version, with
    // migrations 1..N applied contiguously. Record those as applied.
    const legacy = database.pragma('user_version', { simple: true }) as number;
    const mark = database.prepare('INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)');
    for (const m of migrations) if (m.version <= legacy) mark.run(m.version, m.name, new Date().toISOString());
  }
  const applied = new Set(
    (database.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version),
  );
  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    database.transaction(() => {
      database.exec(m.sql);
      database.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, new Date().toISOString());
      // Kept for tools that read it: the highest applied number.
      database.pragma(`user_version = ${Math.max(m.version, database.pragma('user_version', { simple: true }) as number)}`);
    })();
  }
}

migrate(db);

export const COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#14b8a6'];
export const pickColor = () => COLORS[Math.floor(Math.random() * COLORS.length)];
