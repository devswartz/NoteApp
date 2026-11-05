// Page links ([[Page]]) and backlinks. Owner: Editor & Notes.
//
// A link is an inline `pageLink` node holding a `pageId` in the page's Yjs doc.
// Backlinks are found from an in-memory index that's rebuilt lazily: each page's
// outgoing links are cached together with its `updated_at`, and re-read from the
// stored Yjs state only when the page has changed since. So the collab server
// needs no hook, and a restart just means one rescan on the first request.
import * as Y from 'yjs';
import { db } from './db.ts';
import { NOTEBOOK_VISIBLE } from './access.ts';

const cache = new Map<string, { updatedAt: string; targets: Set<string> }>();

/** Page ids linked from a Yjs document (pageLink nodes anywhere in the tree). */
export function linksInDoc(doc: Y.Doc): Set<string> {
  const out = new Set<string>();
  const walk = (node: Y.XmlFragment | Y.XmlElement) => {
    for (const child of node.toArray()) {
      if (child instanceof Y.XmlElement) {
        if (child.nodeName === 'pageLink') {
          const id = child.getAttribute('pageId');
          if (typeof id === 'string' && id) out.add(id);
        }
        walk(child);
      } else if (child instanceof Y.XmlText) {
        // Inline nodes in a text block are embedded in the XmlText delta.
        for (const d of child.toDelta() as { insert: unknown }[]) {
          if (d.insert instanceof Y.XmlElement) {
            if (d.insert.nodeName === 'pageLink') {
              const id = d.insert.getAttribute('pageId');
              if (typeof id === 'string' && id) out.add(id);
            }
            walk(d.insert);
          }
        }
      }
    }
  };
  walk(doc.getXmlFragment('default'));
  return out;
}

function targetsOf(pageId: string, updatedAt: string): Set<string> {
  const hit = cache.get(pageId);
  if (hit && hit.updatedAt === updatedAt) return hit.targets;
  const ydoc = (db.prepare('SELECT ydoc FROM pages WHERE id = ?').get(pageId) as { ydoc: Buffer | null } | undefined)?.ydoc ?? null;
  let targets = new Set<string>();
  if (ydoc?.length) {
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, new Uint8Array(ydoc));
      targets = linksInDoc(doc);
    } finally {
      doc.destroy();
    }
  }
  cache.set(pageId, { updatedAt, targets });
  return targets;
}

export interface Backlink {
  id: string;
  title: string;
  icon: string | null;
  sectionName: string;
  notebookName: string;
  updatedAt: string;
}

/** Pages in the workspace that link to `pageId` and that `userId` can see, most recently edited first. */
export function backlinks(pageId: string, workspaceId: string, userId: string): Backlink[] {
  // Only pages updated since we last read them pay for decoding.
  const rows = db
    .prepare(
      `SELECT pg.id, pg.title, pg.icon, pg.updated_at AS updatedAt, s.name AS sectionName, n.name AS notebookName
       FROM pages pg JOIN sections s ON s.id = pg.section_id JOIN notebooks n ON n.id = s.notebook_id
       WHERE n.workspace_id = @workspaceId AND pg.id != @pageId AND ${NOTEBOOK_VISIBLE}
       ORDER BY pg.updated_at DESC`,
    )
    .all({ workspaceId, pageId, userId }) as Backlink[];
  return rows.filter((r) => targetsOf(r.id, r.updatedAt).has(pageId));
}
