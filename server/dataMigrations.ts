// Data migrations: changes to stored content (Yjs docs) that SQL can't make. They run at
// startup, after the schema migrations (server/db.ts) and before the server takes requests.
// Each step must be idempotent (safe to run on every start): it finds what still needs doing
// and does only that, in small batches so a large database is never held in memory at once.
import * as Y from 'yjs';
import { db } from './db.ts';
import { clearPositionMigrations, newBoxId } from './collab.ts';
import { snapshot } from './versions.ts';
import { convertPageDoc } from '../shared/pageDoc.ts';

const BATCH = 100;

/**
 * Every page is a canvas (docs/PLAN_CANVAS.md, decision of 2026-11-11): turn each remaining
 * `kind = 'document'` page into a canvas whose one wide box holds its content (lossless, the
 * same conversion as POST /pages/:id/convert). The page as it was is kept as a version first,
 * so it can be restored from Version history. Edit times are left alone. Returns the count.
 */
export function convertDocumentPages(batch = BATCH): number {
  const next = db.prepare("SELECT id FROM pages WHERE kind = 'document' AND id > ? ORDER BY id LIMIT ?");
  const read = db.prepare('SELECT ydoc FROM pages WHERE id = ?');
  const write = db.prepare("UPDATE pages SET kind = 'canvas', ydoc = COALESCE(?, ydoc) WHERE id = ? AND kind = 'document'");
  let converted = 0;
  let after = '';
  for (;;) {
    const ids = (next.all(after, batch) as { id: string }[]).map((r) => r.id);
    if (!ids.length) break;
    after = ids[ids.length - 1]!;
    for (const id of ids) {
      try {
        db.transaction(() => {
          snapshot(id, 'manual'); // nothing to keep for a page that was never written in
          const row = read.get(id) as { ydoc: Buffer | null } | undefined;
          if (!row) return;
          let state: Buffer | null = null;
          if (row.ydoc?.length) {
            const doc = new Y.Doc();
            try {
              Y.applyUpdate(doc, new Uint8Array(row.ydoc));
              convertPageDoc(doc, 'canvas', newBoxId);
              state = Buffer.from(Y.encodeStateAsUpdate(doc));
            } finally {
              doc.destroy();
            }
          }
          if (write.run(state, id).changes) converted++;
        })();
      } catch (e) {
        // A damaged doc is left as it is (the server still reads a document's content); the rest go on.
        console.error(`Could not convert page ${id} to a canvas`, e);
      }
    }
  }
  return converted;
}

/**
 * Empty the position-migration maps that @tiptap/y-tiptap 3.0.x left in stored docs (see
 * clearPositionMigrations). Only pages whose doc mentions the map are read; a page is written
 * only if something was removed, so later starts just re-read those pages. Returns the count.
 */
export function clearStoredPositionMigrations(batch = BATCH): number {
  const next = db.prepare("SELECT id FROM pages WHERE id > ? AND instr(ydoc, CAST('__tiptap_position_migrations:' AS BLOB)) > 0 ORDER BY id LIMIT ?");
  const read = db.prepare('SELECT ydoc FROM pages WHERE id = ?');
  const write = db.prepare('UPDATE pages SET ydoc = ? WHERE id = ?');
  let cleaned = 0;
  let after = '';
  for (;;) {
    const ids = (next.all(after, batch) as { id: string }[]).map((r) => r.id);
    if (!ids.length) break;
    after = ids[ids.length - 1]!;
    for (const id of ids) {
      const doc = new Y.Doc();
      try {
        const row = read.get(id) as { ydoc: Buffer | null } | undefined;
        if (!row?.ydoc?.length) continue;
        Y.applyUpdate(doc, new Uint8Array(row.ydoc));
        if (clearPositionMigrations(doc)) {
          write.run(Buffer.from(Y.encodeStateAsUpdate(doc)), id);
          cleaned++;
        }
      } catch (e) {
        console.error(`Could not clean page ${id}`, e);
      } finally {
        doc.destroy();
      }
    }
  }
  return cleaned;
}

/** Run every data migration; logs what each one changed. */
export function runDataMigrations() {
  const pages = convertDocumentPages();
  if (pages) console.log(`Data migration: converted ${pages} document page${pages === 1 ? '' : 's'} to canvas pages (each kept as a version)`);
  const cleaned = clearStoredPositionMigrations();
  if (cleaned) console.log(`Data migration: removed editor position records from ${cleaned} page${cleaned === 1 ? '' : 's'}`);
}
