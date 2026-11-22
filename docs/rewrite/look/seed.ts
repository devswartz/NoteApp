// Seeds a fresh DATA_DIR for the reference screenshots (docs/rewrite/look/README.md).
// Run BEFORE the server starts, with the same env the server gets:
//   DATA_DIR=<scratch> DEMO_PASSWORD=demo-pass-123 node --import tsx docs/rewrite/look/seed.ts
// It runs the normal demo seed (server/demo.ts: demo@example.com, "Demo Team" with notebooks,
// pages and tasks) and adds, in Demo Team, a notebook "Look reference" with:
//   - section "Corpus": one page per tests/corpus case, its page.bin as the page's Y.Doc
//     (task ids t1/t2/t3/tb are remapped to real tasks, mentions to the demo users,
//     the page link to the first corpus page)
//   - section "Empty section": no pages (empty-state screenshot)
//   - page "Sandbox" (in "Corpus"): a copy of canvas-boxes that the capture script types into
// and a workspace "Empty Space" with nothing in it (empty Notes and Tasks screenshots).
// Idempotent only on an empty DATA_DIR: delete the directory to start again.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as Y from 'yjs';
import { db, newId, now } from '../../../server/db.ts';
import { seedDemoIfEmpty } from '../../../server/demo.ts';
import { createTask } from '../../../server/tasks.ts';
import { extractPage } from '../../../server/collab.ts';
import { pageFragments } from '../../../shared/pageDoc.ts';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../../..');
const CASES = path.join(ROOT, 'tests/corpus/cases');
const ORDER = ['canvas-boxes', 'sandbox', 'blocks', 'lists', 'tasks', 'settings-and-ink', 'document-page', 'geometry-defaults', 'converted'];

if (!seedDemoIfEmpty()) {
  console.log('look seed: database not empty, nothing done (delete DATA_DIR to reseed)');
  process.exit(0);
}

const demo = (db.prepare("SELECT id FROM users WHERE email = 'demo@example.com'").get() as { id: string }).id;
const sam = (db.prepare("SELECT id FROM users WHERE email = 'sam@example.com'").get() as { id: string }).id;
const team = (db.prepare("SELECT id FROM workspaces WHERE name = 'Demo Team'").get() as { id: string }).id;

const nb = newId();
db.prepare('INSERT INTO notebooks (id, workspace_id, name, color, visibility, created_by, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
  nb, team, 'Look reference', '#ec4899', 'shared', demo, 1, now(),
);
const sec = (name: string, color: string, position: number) => {
  const id = newId();
  db.prepare('INSERT INTO sections (id, notebook_id, name, color, position, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, nb, name, color, position, now());
  return id;
};
const corpusSec = sec('Corpus', '#ec4899', 1);
sec('Empty section', '#14b8a6', 2);

/** Rewrites attributes in every element of every fragment. */
function remap(doc: Y.Doc, fn: (el: Y.XmlElement) => void) {
  const walk = (n: Y.XmlFragment | Y.XmlElement) => {
    for (const c of n.toArray()) if (c instanceof Y.XmlElement) { fn(c); walk(c); }
  };
  doc.transact(() => { for (const f of pageFragments(doc)) walk(f); });
}

let firstPage = '';
ORDER.forEach((name, i) => {
  const dir = path.join(CASES, name === 'sandbox' ? 'canvas-boxes' : name);
  const input = JSON.parse(fs.readFileSync(path.join(dir, 'input.json'), 'utf8')) as { title: string; tasks: Record<string, { title: string; done: boolean; due?: string | null } | null> };
  const expected = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8')) as { kind: string };
  const id = newId();
  const ts = now();
  db.prepare('INSERT INTO pages (id, section_id, title, icon, kind, position, created_by, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id, corpusSec, name === 'sandbox' ? 'Sandbox' : input.title, null, expected.kind, i + 1, demo, ts, ts, demo,
  );
  if (!firstPage) firstPage = id;
  // Real tasks for the case's task ids (t3 is t1's subtask in the tasks case).
  const ids: Record<string, string> = {};
  for (const [key, t] of Object.entries(input.tasks)) {
    if (!t) continue;
    const parentId = name === 'tasks' && key === 't3' ? ids.t1 : undefined;
    const task = createTask(demo, team, { id: crypto.randomUUID(), title: t.title, pageId: parentId ? undefined : id, parentId, dueDate: t.due ?? undefined, assigneeId: demo });
    if (t.done) db.prepare("UPDATE tasks SET status = 'done', completed_at = ?, completed_by = ? WHERE id = ?").run(now(), demo, task.id);
    ids[key] = task.id;
  }
  const doc = new Y.Doc();
  Y.applyUpdate(doc, fs.readFileSync(path.join(dir, 'page.bin')));
  remap(doc, (el) => {
    if (el.nodeName === 'taskRef') {
      const t = el.getAttribute('taskId') as string;
      el.setAttribute('taskId', ids[t] ?? crypto.randomUUID()); // unknown/hidden: an id no task has
    }
    if (el.nodeName === 'mention') el.setAttribute('id', el.getAttribute('id') === 'u1' ? demo : sam);
    if (el.nodeName === 'pageLink') el.setAttribute('pageId', firstPage);
  });
  const { text } = extractPage(doc);
  db.prepare('UPDATE pages SET ydoc = ?, text = ? WHERE id = ?').run(Buffer.from(Y.encodeStateAsUpdate(doc)), text, id);
  db.prepare('INSERT INTO pages_fts (page_id, title, text) VALUES (?, ?, ?)').run(id, name === 'sandbox' ? 'Sandbox' : input.title, text);
});

// An empty team workspace (no notebooks, no tasks): straight SQL, as createWorkspace() adds starter content.
const empty = newId();
db.prepare('INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)').run(empty, 'Empty Space', demo, now());
db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)").run(empty, demo, now());
console.log(`look seed: Demo Team + "Look reference" notebook with ${ORDER.length} pages, and Empty Space`);
