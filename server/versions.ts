// Page version history. Owner: Editor & Notes.
//
// Snapshots are full Yjs states copied from pages.ydoc. No hook into the collab
// server is needed: a snapshot is taken
//   - by a background sweep every SWEEP_MS for pages edited since their last snapshot
//     (at most one per page per MIN_GAP_MS), and when someone opens the history;
//   - before a restore, so a restore can itself be undone.
// Retention: every snapshot from the last 24 h, then one per hour for 7 days, then
// one per day, up to MAX_PER_PAGE.
import crypto from 'node:crypto';
import { db } from './db.ts';

export const MIN_GAP_MS = 10 * 60 * 1000;
const SWEEP_MS = 5 * 60 * 1000;
const MAX_PER_PAGE = 200;

export interface VersionMeta {
  id: string;
  title: string;
  authorId: string | null;
  reason: 'auto' | 'restore' | 'manual';
  /** When the content was last edited before this snapshot. */
  at: string;
  createdAt: string;
}

type Reason = VersionMeta['reason'];

/**
 * Snapshot the page's stored state. For 'auto', skips if nothing changed since the last
 * snapshot or the last one is younger than MIN_GAP_MS. Returns the new version id, or null.
 */
export function snapshot(pageId: string, reason: Reason = 'auto', at = Date.now()): string | null {
  const page = db.prepare('SELECT ydoc, title, updated_at, updated_by FROM pages WHERE id = ?').get(pageId) as
    | { ydoc: Buffer | null; title: string; updated_at: string; updated_by: string | null }
    | undefined;
  if (!page?.ydoc?.length) return null;
  const last = db
    .prepare('SELECT page_updated_at, created_at, ydoc FROM page_versions WHERE page_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(pageId) as { page_updated_at: string; created_at: string; ydoc: Buffer } | undefined;
  if (last && last.ydoc.equals(page.ydoc)) return null; // identical content
  if (reason === 'auto' && last) {
    if (last.page_updated_at >= page.updated_at) return null;
    if (at - Date.parse(last.created_at) < MIN_GAP_MS) return null;
  }
  const id = crypto.randomUUID();
  db.prepare(
    'INSERT INTO page_versions (id, page_id, ydoc, title, author_id, reason, page_updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, pageId, page.ydoc, page.title, page.updated_by, reason, page.updated_at, new Date(at).toISOString());
  prune(pageId, at);
  return id;
}

/** Thin out old snapshots: keep everything < 24 h, one per hour < 7 d, one per day after; cap the total. */
export function prune(pageId: string, at = Date.now()) {
  const rows = db.prepare('SELECT id, created_at FROM page_versions WHERE page_id = ? ORDER BY created_at DESC').all(pageId) as {
    id: string;
    created_at: string;
  }[];
  const keep = new Set<string>();
  const buckets = new Set<string>();
  for (const r of rows) {
    const age = at - Date.parse(r.created_at);
    const t = r.created_at;
    const bucket = age < 864e5 ? r.id : age < 7 * 864e5 ? `h${t.slice(0, 13)}` : `d${t.slice(0, 10)}`;
    if (buckets.has(bucket)) continue;
    buckets.add(bucket);
    if (keep.size < MAX_PER_PAGE) keep.add(r.id);
  }
  const drop = rows.filter((r) => !keep.has(r.id));
  const del = db.prepare('DELETE FROM page_versions WHERE id = ?');
  db.transaction(() => drop.forEach((r) => del.run(r.id)))();
}

export function listVersions(pageId: string): VersionMeta[] {
  return db
    .prepare(
      `SELECT id, title, author_id AS authorId, reason, page_updated_at AS at, created_at AS createdAt
       FROM page_versions WHERE page_id = ? ORDER BY created_at DESC`,
    )
    .all(pageId) as VersionMeta[];
}

export function getVersion(pageId: string, id: string): (VersionMeta & { ydoc: Buffer }) | undefined {
  return db
    .prepare(
      `SELECT id, title, author_id AS authorId, reason, page_updated_at AS at, created_at AS createdAt, ydoc
       FROM page_versions WHERE page_id = ? AND id = ?`,
    )
    .get(pageId, id) as (VersionMeta & { ydoc: Buffer }) | undefined;
}

/** Snapshot every page edited since its last snapshot (respecting MIN_GAP_MS). */
export function sweep(at = Date.now()) {
  const since = new Date(at - 2 * SWEEP_MS - MIN_GAP_MS).toISOString();
  const pages = db
    .prepare(
      `SELECT p.id FROM pages p WHERE p.updated_at > ? AND p.updated_at > COALESCE(
         (SELECT MAX(v.page_updated_at) FROM page_versions v WHERE v.page_id = p.id), '')`,
    )
    .all(since) as { id: string }[];
  for (const p of pages) snapshot(p.id, 'auto', at);
}

let timer: NodeJS.Timeout | null = null;
/** Start the background sweep (idempotent; doesn't keep the process alive). */
export function startVersionSweep() {
  if (timer) return;
  timer = setInterval(() => {
    try {
      sweep();
    } catch (e) {
      console.error('version sweep failed', e);
    }
  }, SWEEP_MS);
  timer.unref();
}

