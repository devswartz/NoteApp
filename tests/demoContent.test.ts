// SEED_DEMO showcase content (server/demoContent.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { mainFragment } from '../shared/pageDoc.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'noteapp-demo-'));
process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = tmp;
process.env.JWT_SECRET = 'test';
process.env.DEMO_PASSWORD = 'demo-password';
const { seedDemoIfEmpty } = await import('../server/demo.ts');
const { db } = await import('../server/db.ts');
const { backlinks } = await import('../server/links.ts');
const { NOTEBOOK_VISIBLE } = await import('../server/access.ts');

seedDemoIfEmpty();
const user = (email: string) => (db.prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: string }).id;
const demo = user('demo@example.com');
const sam = user('sam@example.com');
const team = (db.prepare("SELECT id FROM workspaces WHERE name = 'Demo Team'").get() as { id: string }).id;
const pageId = (title: string) => (db.prepare('SELECT id FROM pages WHERE title LIKE ?').get(title) as { id: string }).id;
const docOf = (id: string) => {
  const d = new Y.Doc();
  Y.applyUpdate(d, new Uint8Array((db.prepare('SELECT ydoc FROM pages WHERE id = ?').get(id) as { ydoc: Buffer }).ydoc));
  return mainFragment(d);
};
const nodeNames = (frag: Y.XmlFragment) => {
  const out = new Set<string>();
  const walk = (n: Y.XmlFragment | Y.XmlElement) =>
    n.toArray().forEach((c) => {
      if (c instanceof Y.XmlElement) {
        out.add(c.nodeName);
        walk(c);
      }
    });
  walk(frag);
  return out;
};

test('a notebook per area, plus a private one only its creator sees', () => {
  const names = (userId: string) =>
    (db.prepare(`SELECT n.name FROM notebooks n WHERE n.workspace_id = @team AND ${NOTEBOOK_VISIBLE}`).all({ team, userId }) as { name: string }[]).map((r) => r.name);
  for (const nb of ['Product', 'Engineering', 'Marketing', 'Personal (private)']) assert.ok(names(demo).includes(nb), nb);
  assert.ok(!names(sam).includes('Personal (private)'));
});

test('pages use every block type the editor has', () => {
  const all = new Set<string>();
  for (const t of ['Q4 roadmap', 'Weekly sync%', 'Search architecture', 'Launch plan', 'Private ideas']) nodeNames(docOf(pageId(t))).forEach((n) => all.add(n));
  for (const n of ['heading', 'paragraph', 'bulletList', 'orderedList', 'taskList', 'blockquote', 'callout', 'details', 'codeBlock', 'table', 'image', 'fileAttachment', 'taskRef', 'pageLink', 'horizontalRule']) {
    assert.ok(all.has(n), n);
  }
});

test('formatting does not leak into the following text', () => {
  const frag = docOf(pageId('Q4 roadmap'));
  const callout = frag.toArray()[0] as Y.XmlElement;
  const para = callout.toArray()[0] as Y.XmlElement;
  const delta = (para.toArray()[0] as Y.XmlText).toDelta() as { insert: string; attributes?: object }[];
  assert.deepEqual(delta[0], { insert: 'Goal: ', attributes: { bold: {} } });
  assert.equal(delta[1].attributes, undefined, 'the text after the bold run is plain');
});

test('meeting notes: embedded tasks (assigned, due, recurring, with subtasks), backlinks, a comment thread and versions', () => {
  const meeting = pageId('Weekly sync%');
  const tasks = db.prepare('SELECT * FROM tasks WHERE page_id = ? AND parent_id IS NULL').all(meeting) as { id: string; assignee_id: string; due_date: string; recurrence: string | null }[];
  assert.equal(tasks.length, 3);
  assert.ok(tasks.some((t) => t.recurrence));
  assert.ok(tasks.some((t) => t.assignee_id === sam));
  const withSubtasks = tasks.find((t) => (db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ?').get(t.id) as { n: number }).n === 2);
  assert.ok(withSubtasks, 'a task with two subtasks');
  // Roadmap is linked from the meeting, the spec and the launch plan.
  const roadmapLinks = backlinks(pageId('Q4 roadmap'), team, demo).map((b) => b.title);
  assert.equal(roadmapLinks.length, 3, roadmapLinks.join(', '));
  const thread = db.prepare('SELECT id FROM comment_threads WHERE page_id = ?').get(meeting) as { id: string };
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM comments WHERE thread_id = ?').get(thread.id) as { n: number }).n, 2);
  assert.ok(docOf(meeting).toString().includes(thread.id), 'the thread is anchored in the text');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM page_versions WHERE page_id = ?').get(meeting) as { n: number }).n, 2);
});

test('the image and the attachment are real uploads', () => {
  const files = db.prepare('SELECT id, ext, mime FROM files WHERE workspace_id = ?').all(team) as { id: string; ext: string; mime: string }[];
  assert.equal(files.length, 2);
  for (const f of files) assert.ok(fs.existsSync(path.join(tmp, 'files', f.id + f.ext)), f.id);
  const png = files.find((f) => f.mime === 'image/png')!;
  assert.deepEqual([...fs.readFileSync(path.join(tmp, 'files', png.id + '.png')).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

test('demo pages are searchable', () => {
  const hits = db.prepare("SELECT page_id FROM pages_fts WHERE pages_fts MATCH 'benchmark'").all();
  assert.ok(hits.length >= 1);
});
