// SEED_DEMO showcase content for the "Demo Team" workspace (staging): a notebook per
// area and pages that use every editor feature: templates' structure, embedded tasks
// (assigned, due, recurring, subtasks), page links and backlinks, a table, an image,
// a file card, highlighted code, a callout, a toggle, a comment thread, version
// history and a private notebook. Owner: Editor & Notes. Called from server/demo.ts.
import * as Y from 'yjs';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { db, newId, now } from './db.ts';
import { seedPageDoc } from './collab.ts';
import { createTask } from './tasks.ts';
import { FILES_DIR } from './config.ts';
import { addDays, today } from '../shared/dates.ts';

// ───────── Yjs builders (ProseMirror-shaped XML) ─────────

type Marks = Record<string, object>;
type Inline = string | { text: string; marks: Marks } | Y.XmlElement;
type Block = Y.XmlElement;

/** Text and inline nodes. Every run gets explicit attributes, so formatting never leaks into the next run. */
function inline(parts: Inline[]): (Y.XmlText | Y.XmlElement)[] {
  const out: (Y.XmlText | Y.XmlElement)[] = [];
  let text: Y.XmlText | null = null;
  let i = 0;
  for (const p of parts) {
    if (p instanceof Y.XmlElement) {
      out.push(p);
      text = null;
      continue;
    }
    if (!text) {
      text = new Y.XmlText();
      out.push(text);
      i = 0;
    }
    const [s, marks] = typeof p === 'string' ? [p, {}] : [p.text, p.marks];
    text.insert(i, s, marks);
    i += s.length;
  }
  return out;
}
function el(name: string, attrs: Record<string, unknown>, children: (Y.XmlElement | Y.XmlText)[] = []) {
  const e = new Y.XmlElement(name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v as string);
  if (children.length) e.insert(0, children);
  return e;
}
const p = (...parts: Inline[]) => el('paragraph', {}, inline(parts));
const h = (level: 1 | 2 | 3, s: string) => el('heading', { level }, inline([s]));
const bold = (text: string) => ({ text, marks: { bold: {} } });
const italic = (text: string) => ({ text, marks: { italic: {} } });
const code = (text: string) => ({ text, marks: { code: {} } });
const link = (text: string, href: string) => ({ text, marks: { link: { href } } });
const commented = (text: string, threadId: string) => ({ text, marks: { comment: { threadId } } });
const bullets = (...items: Inline[][]) => el('bulletList', {}, items.map((i) => el('listItem', {}, [p(...i)])));
const numbered = (...items: Inline[][]) => el('orderedList', {}, items.map((i) => el('listItem', {}, [p(...i)])));
const checklist = (...items: [string, boolean][]) =>
  el('taskList', {}, items.map(([t, checked]) => el('taskItem', { checked }, [p(t)])));
const quote = (...parts: Inline[]) => el('blockquote', {}, [p(...parts)]);
const callout = (emoji: string, ...blocks: Block[]) => el('callout', { emoji }, blocks);
const toggle = (summary: string, ...blocks: Block[]) =>
  el('details', {}, [el('detailsSummary', {}, inline([summary])), el('detailsContent', {}, blocks.length ? blocks : [p()])]);
const codeBlock = (language: string, src: string) => el('codeBlock', { language }, inline([src]));
const hr = () => el('horizontalRule', {});
const taskRef = (taskId: string) => el('taskRef', { taskId });
const pageLink = (pageId: string) => el('pageLink', { pageId });
const image = (src: string, alt: string) => el('image', { src, alt });
const fileCard = (f: { url: string; name: string; size: number; mime: string }) => el('fileAttachment', { ...f });
const cell = (s: string, header = false) => el(header ? 'tableHeader' : 'tableCell', {}, [p(s)]);
const table = (rows: string[][]) => el('table', {}, rows.map((r, i) => el('tableRow', {}, r.map((c) => cell(c, i === 0)))));

// ───────── Tree, files and versions ─────────

function notebook(ws: string, userId: string, name: string, color: string, position: number, visibility: 'shared' | 'private' = 'shared') {
  const id = newId();
  db.prepare(
    'INSERT INTO notebooks (id, workspace_id, name, color, visibility, created_by, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, ws, name, color, visibility, userId, position, now());
  return id;
}
function section(notebookId: string, name: string, color: string, position: number) {
  const id = newId();
  db.prepare('INSERT INTO sections (id, notebook_id, name, color, position, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id, notebookId, name, color, position, now(),
  );
  return id;
}
function page(sectionId: string, userId: string, title: string, icon: string | null, position: number) {
  const id = newId();
  const ts = now();
  db.prepare(
    'INSERT INTO pages (id, section_id, title, icon, position, created_by, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, sectionId, title, icon, position, userId, ts, ts, userId);
  db.prepare('INSERT INTO pages_fts (page_id, title, text) VALUES (?, ?, ?)').run(id, title, '');
  return id;
}
function fill(pageId: string, blocks: Block[]) {
  seedPageDoc(pageId, (frag) => frag.insert(0, blocks));
}

/** A simple bar-chart PNG (no image library needed), stored like an upload. */
function chartPng(ws: string, pageId: string, userId: string) {
  const w = 480;
  const hgt = 240;
  const bars = [0.35, 0.55, 0.7, 0.9];
  const colors = [
    [99, 102, 241],
    [14, 165, 233],
    [16, 185, 129],
    [245, 158, 11],
  ];
  const raw = Buffer.alloc((w * 3 + 1) * hgt);
  for (let y = 0; y < hgt; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      let rgb = [248, 248, 250];
      const slot = Math.floor((x - 40) / 105);
      const inBar = x >= 40 && slot < 4 && (x - 40) % 105 < 70;
      if (inBar && hgt - 20 - y < bars[slot] * (hgt - 40) && y < hgt - 20) rgb = colors[slot];
      if (y === hgt - 20 && x >= 30) rgb = [180, 180, 190];
      raw[o] = rgb[0];
      raw[o + 1] = rgb[1];
      raw[o + 2] = rgb[2];
    }
  }
  const crc = (b: Buffer) => {
    let c = ~0;
    for (const byte of b) {
      c ^= byte;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(hgt, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return storeFile(ws, pageId, userId, 'quarterly-signups.png', 'image/png', '.png', png);
}

function storeFile(ws: string, pageId: string, userId: string, name: string, mime: string, ext: string, bytes: Buffer) {
  const id = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(FILES_DIR, { recursive: true });
  fs.writeFileSync(path.join(FILES_DIR, id + ext), bytes);
  db.prepare('INSERT INTO files (id, workspace_id, page_id, name, ext, mime, size, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id, ws, pageId, name, ext, mime, bytes.length, userId, now(),
  );
  return { url: `/uploads/${id}${ext}`, name, size: bytes.length, mime };
}

/** Record the page's current content as a past version (for the version history demo). */
function snapshotAs(pageId: string, authorId: string, minutesAgo: number) {
  const row = db.prepare('SELECT ydoc, title FROM pages WHERE id = ?').get(pageId) as { ydoc: Buffer; title: string };
  const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  db.prepare(
    "INSERT INTO page_versions (id, page_id, ydoc, title, author_id, reason, page_updated_at, created_at) VALUES (?, ?, ?, ?, ?, 'auto', ?, ?)",
  ).run(newId(), pageId, row.ydoc, row.title, authorId, at, at);
}

function commentThread(ws: string, pageId: string, threadId: string, quoteText: string, messages: [string, string, number][]) {
  const first = messages[0];
  const created = new Date(Date.now() - first[2] * 60_000).toISOString();
  db.prepare('INSERT INTO comment_threads (id, workspace_id, page_id, quote, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    threadId, ws, pageId, quoteText, first[0], created,
  );
  for (const [author, body, minutesAgo] of messages) {
    db.prepare('INSERT INTO comments (id, thread_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)').run(
      newId(), threadId, author, body, new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    );
  }
}

// ───────── The showcase ─────────

export function seedDemoContent(team: string, demo: string, sam: string) {
  const t = today();
  const fmt = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

  const product = notebook(team, demo, 'Product', '#6366f1', 10);
  const roadmapSec = section(product, 'Roadmap', '#6366f1', 1);
  const meetingsSec = section(product, 'Meetings', '#0ea5e9', 2);
  const engineering = notebook(team, demo, 'Engineering', '#10b981', 11);
  const specsSec = section(engineering, 'Specs', '#10b981', 1);
  const marketing = notebook(team, demo, 'Marketing', '#f59e0b', 12);
  const launchSec = section(marketing, 'Launch', '#f59e0b', 1);
  const personal = notebook(team, demo, 'Personal (private)', '#8b5cf6', 13, 'private');
  const personalSec = section(personal, 'Ideas', '#8b5cf6', 1);

  const roadmap = page(roadmapSec, demo, 'Q4 roadmap', '🗺️', 1);
  const meeting = page(meetingsSec, demo, `Weekly sync · ${fmt(t)}`, '🤝', 1);
  const spec = page(specsSec, sam, 'Search architecture', '💻', 1);
  const launch = page(launchSec, demo, 'Launch plan', '🚀', 1);
  const ideas = page(personalSec, demo, 'Private ideas', '🔒', 1);

  // Tasks embedded in the meeting notes: assigned, due, priority, recurring, and a task with subtasks.
  const notes = createTask(demo, team, { title: 'Send the meeting notes to the team', pageId: meeting, assigneeId: demo, dueDate: t, priority: 2 });
  const pricing = createTask(demo, team, { title: 'Finalise launch pricing', pageId: meeting, assigneeId: sam, dueDate: addDays(t, 2), priority: 1 });
  createTask(demo, team, { title: 'Check competitor pricing pages', parentId: pricing.id, assigneeId: sam, dueDate: addDays(t, 1) });
  createTask(demo, team, { title: 'Draft three pricing options', parentId: pricing.id, assigneeId: sam, dueDate: addDays(t, 2) });
  const standup = createTask(demo, team, {
    title: 'Prepare the weekly sync agenda',
    pageId: meeting,
    assigneeId: demo,
    dueDate: addDays(t, 6),
    dueTime: '09:30',
    recurrence: { freq: 'week', interval: 1 },
  });
  const launchTask = createTask(demo, team, { title: 'Write the launch announcement', pageId: launch, assigneeId: demo, dueDate: addDays(t, 5), priority: 3 });
  const indexTask = createTask(sam, team, { title: 'Benchmark search on 10k pages', pageId: spec, assigneeId: sam, dueDate: addDays(t, 3) });

  // Roadmap: callout, table, toggle, links.
  fill(roadmap, [
    callout('🎯', p(bold('Goal: '), 'ship collaborative notes with real tasks to the whole team by the end of the quarter.')),
    h(2, 'Milestones'),
    table([
      ['Milestone', 'Owner', 'Target'],
      ['Editor and tasks', 'Demo User', 'October'],
      ['Search and offline', 'Sam Teammate', 'November'],
      ['Desktop and mobile apps', 'Demo User', 'December'],
    ]),
    h(2, 'Plan'),
    p('The marketing side lives in ', pageLink(launch), ', and the technical design in ', pageLink(spec), '.'),
    numbered(['Private beta with the core team'], ['Public beta and feedback'], ['General availability']),
    toggle('Out of scope this quarter', bullets(['Public share links'], ['AI summaries'], ['Calendar sync'])),
  ]);

  // Meeting notes (the "Meeting notes" template's structure), with a comment thread.
  const thread = newId();
  const draft: Block[] = [
    p(bold('Date: '), fmt(t)),
    h(2, 'Attendees'),
    bullets(['Demo User'], ['Sam Teammate']),
    h(2, 'Agenda'),
    numbered(['Roadmap check-in'], ['Launch pricing'], ['Search performance']),
  ];
  fill(meeting, draft);
  snapshotAs(meeting, demo, 95); // an earlier version: just the agenda
  fill(meeting, [
    ...[
      p(bold('Date: '), fmt(t)),
      h(2, 'Attendees'),
      bullets(['Demo User'], ['Sam Teammate']),
      h(2, 'Agenda'),
      numbered(['Roadmap check-in'], ['Launch pricing'], ['Search performance']),
    ],
    h(2, 'Notes'),
    p('We are on track for the ', pageLink(roadmap), '. ', commented('Search feels slow on very long pages', thread), '; Sam will benchmark it.'),
    quote(italic('“Ship the small thing, then make it great.”')),
    h(2, 'Decisions'),
    bullets(['Launch with two pricing tiers'], ['Keep the weekly sync on Mondays']),
    h(2, 'Action items'),
    taskRef(notes.id),
    taskRef(pricing.id),
    taskRef(standup.id),
    callout('✅', p('Action items are real tasks: they show up on everyone’s dashboard, and ', bold('Finalise launch pricing'), ' has subtasks.')),
  ]);
  snapshotAs(meeting, sam, 30); // a second version, after the notes were added
  commentThread(team, meeting, thread, 'Search feels slow on very long pages', [
    [sam, 'Is this with code blocks? I saw it on the long spec page.', 40],
    [demo, 'Yes, mostly the spec. I linked it from the roadmap.', 35],
  ]);

  // Spec: code, image, file card, quote.
  const chart = chartPng(team, spec, sam);
  const notesFile = storeFile(
    team,
    spec,
    sam,
    'benchmark-notes.md',
    'text/markdown',
    '.md',
    Buffer.from('# Search benchmark\n\n- 10k pages, 1.2M words\n- p50 query: 4 ms, p99: 18 ms\n'),
  );
  fill(spec, [
    p('How full-text search works, and what we measured. Part of the ', pageLink(roadmap), '.'),
    h(2, 'Query'),
    p('Every term is prefix-matched by ', code('ftsQuery'), ', then ranked with ', code('bm25'), '.'),
    codeBlock(
      'typescript',
      [
        "// Prefix-match every term, rank title hits 10x body hits.",
        'export function ftsQuery(q: string): string {',
        "  return q.split(/\\s+/).filter(Boolean).map((t) => `\"${t}\"*`).join(' ');",
        '}',
      ].join('\n'),
    ),
    h(2, 'Results'),
    image(chart.url, 'Bar chart: weekly signups rising across four quarters'),
    fileCard(notesFile),
    p('Open question: do we need typo tolerance? ', link('SQLite FTS5 docs', 'https://www.sqlite.org/fts5.html')),
    taskRef(indexTask.id),
  ]);

  // Launch plan: checklist, table, a task, and a link back.
  fill(launch, [
    p('Everything for launch day. See the ', pageLink(roadmap), ' for dates.'),
    h(2, 'Checklist'),
    checklist(['Landing page copy', true], ['Screenshots for the app stores', false], ['Press kit', false]),
    h(2, 'Channels'),
    table([
      ['Channel', 'Owner', 'Status'],
      ['Blog', 'Demo User', 'Draft'],
      ['Newsletter', 'Sam Teammate', 'Scheduled'],
    ]),
    taskRef(launchTask.id),
    hr(),
    p(italic('Last reviewed in the '), pageLink(meeting), italic('.')),
  ]);

  // Private notebook: visible only to Demo User.
  fill(ideas, [
    callout('🔒', p('This notebook is ', bold('private'), ': Sam can’t see it, its pages or search results from it.')),
    bullets(['Team offsite in spring?'], ['Try a “no meetings Wednesday”']),
  ]);

  return { roadmap, meeting, spec, launch, ideas };
}
