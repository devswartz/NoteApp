// Onboarding content for a brand-new workspace.
import * as Y from 'yjs';
import { db, newId, now } from './db.ts';
import { seedPageDoc } from './collab.ts';
import { createTask } from './tasks.ts';
import { addDays, today } from '../shared/dates.ts';

type Inline = string | { text: string; marks: Record<string, object> };

function el(name: string, attrs: Record<string, unknown>, children: (Y.XmlElement | Y.XmlText)[]) {
  const e = new Y.XmlElement(name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v as string);
  e.insert(0, children);
  return e;
}
function text(...parts: Inline[]) {
  const t = new Y.XmlText();
  let i = 0;
  for (const p of parts) {
    if (typeof p === 'string') {
      t.insert(i, p);
      i += p.length;
    } else {
      t.insert(i, p.text, p.marks);
      i += p.text.length;
    }
  }
  return t;
}
const p = (...parts: Inline[]) => el('paragraph', {}, [text(...parts)]);
const h = (level: number, s: string) => el('heading', { level }, [text(s)]);
const bold = (s: string) => ({ text: s, marks: { bold: {} } });
const code = (s: string) => ({ text: s, marks: { code: {} } });
const ul = (...items: Inline[][]) => el('bulletList', {}, items.map((i) => el('listItem', {}, [p(...i)])));
const taskRef = (id: string) => el('taskRef', { taskId: id }, []);

export function seedWorkspace(workspaceId: string, userId: string, personal: boolean) {
  const ts = now();
  const nbId = newId();
  db.prepare(
    `INSERT INTO notebooks (id, workspace_id, name, color, visibility, created_by, position, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
  ).run(nbId, workspaceId, personal ? 'My Notebook' : 'Team Notebook', '#6366f1', 'shared', userId, ts);
  const secId = newId();
  db.prepare('INSERT INTO sections (id, notebook_id, name, color, position, created_at) VALUES (?, ?, ?, ?, 1, ?)').run(
    secId,
    nbId,
    'Getting started',
    '#6366f1',
    ts,
  );
  const pageId = newId();
  db.prepare(
    `INSERT INTO pages (id, section_id, title, icon, position, created_by, created_at, updated_at, updated_by)
     VALUES (?, ?, 'Welcome 👋', NULL, 1, ?, ?, ?, ?)`,
  ).run(pageId, secId, userId, ts, ts, userId);

  const t1 = createTask(userId, workspaceId, {
    title: 'Try checking off this task — it also completes on the Tasks dashboard',
    pageId,
    assigneeId: userId,
    dueDate: today(),
    priority: 2,
  });
  const t2 = createTask(userId, workspaceId, {
    title: 'Type /task on a new line to create a task',
    pageId,
    assigneeId: userId,
    dueDate: addDays(today(), 1),
  });
  const t3 = createTask(userId, workspaceId, {
    title: 'Invite a teammate from Workspace settings',
    pageId,
    dueDate: addDays(today(), 3),
    priority: 3,
  });

  seedPageDoc(pageId, (frag) => {
    frag.insert(0, [
      p('This is your workspace: ', bold('notebooks'), ' contain ', bold('sections'), ', and sections contain ', bold('pages'), '. Everything saves automatically and syncs live with anyone you share it with.'),
      h(2, 'Tasks live inside your notes'),
      p('Each task below is a real task. Assign it, give it a due date, or complete it here — it shows up instantly in ', bold('Today'), ', ', bold('My Tasks'), ' and the rest of the dashboard, and links back to this page.'),
      taskRef(t1.id),
      taskRef(t2.id),
      taskRef(t3.id),
      h(2, 'Handy shortcuts'),
      ul(
        [code('/'), ' — insert anything: headings, tasks, tables, images, files'],
        [code('/task'), ' — new task  ·  ', code('Ctrl+Enter'), ' (', code('⌘ Enter'), ' on a Mac) — turn the current line into a task'],
        [code('⌘K'), ' — search notes and tasks  ·  ', code('Q'), ' — quick-add a task from anywhere'],
        [code('?'), ' — see every keyboard shortcut'],
      ),
      p('Quick add understands natural language: try ', code('Send report friday p1 @me every week'), '.'),
    ]);
  });
}
