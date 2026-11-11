import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { mainFragment } from '../shared/pageDoc.ts';

process.env.DB_FILE = ':memory:';
process.env.JWT_SECRET = 'test-secret';
const { db } = await import('../server/db.ts');
const { createWorkspace } = await import('../server/workspaces.ts');

test('onboarding page: formatting applies only to the marked words', () => {
  db.prepare("INSERT INTO users (id, email, name, password_hash, color, created_at) VALUES ('u1', 'a@b.c', 'A', 'x', '#000', '2026-01-01')").run();
  const ws = createWorkspace('u1', 'W', true);
  const row = db
    .prepare('SELECT p.ydoc FROM pages p JOIN sections s ON s.id = p.section_id JOIN notebooks n ON n.id = s.notebook_id WHERE n.workspace_id = ?')
    .get(ws) as { ydoc: Buffer };
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(row.ydoc));
  const first = mainFragment(doc).toArray()[0] as Y.XmlElement;
  const delta = (first.toArray()[0] as Y.XmlText).toDelta() as { insert: string; attributes?: object }[];
  const bold = delta.filter((d) => d.attributes && 'bold' in d.attributes).map((d) => d.insert);
  assert.deepEqual(bold, ['notebooks', 'sections', 'pages']);
});
