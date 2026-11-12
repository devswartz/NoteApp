// Extra DEMO content for the README and App Store screenshots, on top of SEED_DEMO:
// a "Website Relaunch" project notebook (kickoff meeting from the template, a brief shared with
// an outside person, a numbered outline and a table, a checklist), more tasks and one more user.
// Fictional names only. Run with the server STOPPED, after its first start has seeded the data:
//   DATA_DIR=<same dir> node --import tsx scripts/store-assets/seed-extra.ts
import bcrypt from 'bcryptjs';
import * as Y from 'yjs';
import { db, newId, now, pickColor } from '../../server/db.ts';
import { createWorkspace, grantPageShare } from '../../server/workspaces.ts';
import { seedPageDoc, newBoxId } from '../../server/collab.ts';
import { createTask } from '../../server/tasks.ts';
import { addDays, today } from '../../shared/dates.ts';
import { BOXES_KEY, boxField, newBoxMap } from '../../shared/pageDoc.ts';

type Inl = string | { text: string; marks: Record<string, object> };
function inline(parts: Inl[]) {
  const out: Y.XmlText[] = [];
  const t = new Y.XmlText();
  let i = 0;
  for (const p of parts) {
    const [s, marks] = typeof p === 'string' ? [p, {}] : [p.text, p.marks];
    t.insert(i, s, marks);
    i += s.length;
  }
  out.push(t);
  return out;
}
function el(name: string, attrs: Record<string, unknown>, children: (Y.XmlElement | Y.XmlText)[] = []) {
  const e = new Y.XmlElement(name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v as string);
  if (children.length) e.insert(0, children);
  return e;
}
const p = (...parts: Inl[]) => el('paragraph', {}, inline(parts));
const h = (level: 1 | 2 | 3, s: string) => el('heading', { level }, inline([s]));
const bold = (text: string) => ({ text, marks: { bold: {} } });
const bullets = (...items: Inl[][]) => el('bulletList', {}, items.map((i) => el('listItem', {}, [p(...i)])));
/** Items are [text, children?]; children nest as another ordered list (1 → a → i). */
type Item = [string, Item[]?];
const outline = (items: Item[]): Y.XmlElement =>
  el('orderedList', {}, items.map(([t, kids]) => el('listItem', {}, [p(t), ...(kids ? [outline(kids)] : [])])));
const checklist = (...items: [string, boolean][]) => el('taskList', {}, items.map(([t, c]) => el('taskItem', { checked: c }, [p(t)])));
const callout = (emoji: string, ...blocks: Y.XmlElement[]) => el('callout', { emoji }, blocks);
const taskRef = (taskId: string) => el('taskRef', { taskId });
const cell = (s: string, header = false) => el(header ? 'tableHeader' : 'tableCell', {}, [p(s)]);
const table = (rows: string[][]) => el('table', {}, rows.map((r, i) => el('tableRow', {}, r.map((c) => cell(c, i === 0)))));

/** A canvas page made of several boxes: [x, y, width, blocks]. */
function fillBoxes(pageId: string, boxes: [number, number, number, Y.XmlElement[]][]) {
  seedPageDoc(pageId, (frag) => {
    const doc = frag.doc as Y.Doc;
    const map = doc.getMap<unknown>(BOXES_KEY);
    boxes.forEach(([x, y, w, blocks], i) => {
      const id = newBoxId();
      doc.getXmlFragment(boxField(id)).insert(0, blocks);
      map.set(id, newBoxMap({ x, y, w, z: i + 1 }));
    });
  });
}

const one = <T>(sql: string, ...a: unknown[]) => db.prepare(sql).get(...a) as T;
const demo = one<{ id: string }>("SELECT id FROM users WHERE email = 'demo@example.com'").id;
const sam = one<{ id: string }>("SELECT id FROM users WHERE email = 'sam@example.com'").id;
const team = one<{ id: string }>("SELECT id FROM workspaces WHERE name = 'Demo Team'").id;

// An outside person to share a page with (verified, with a workspace of her own).
const priya = newId();
const ts = now();
db.prepare('INSERT INTO users (id, email, name, password_hash, color, created_at, email_verified_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
  priya, 'priya@example.com', 'Priya Nair', bcrypt.hashSync('unused-demo-pass', 10), pickColor(), ts, ts,
);
createWorkspace(priya, "Priya's Space", true);

const t = today();
const fmt = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

db.transaction(() => {
  const nb = newId();
  db.prepare('INSERT INTO notebooks (id, workspace_id, name, color, visibility, created_by, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    nb, team, 'Café Website', '#ec4899', 'shared', demo, 1, now(),
  );
  const sec = (name: string, color: string, pos: number) => {
    const id = newId();
    db.prepare('INSERT INTO sections (id, notebook_id, name, color, position, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, nb, name, color, pos, now());
    return id;
  };
  const planning = sec('Planning', '#ec4899', 1);
  const design = sec('Design', '#8b5cf6', 2);
  const launchPrep = sec('Launch prep', '#f59e0b', 3);
  const page = (section: string, by: string, title: string, icon: string, pos: number) => {
    const id = newId();
    const n = now();
    db.prepare('INSERT INTO pages (id, section_id, title, icon, position, created_by, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      id, section, title, icon, pos, by, n, n, by,
    );
    db.prepare('INSERT INTO pages_fts (page_id, title, text) VALUES (?, ?, ?)').run(id, title, '');
    return id;
  };
  const kickoff = page(planning, demo, 'Kickoff meeting', '🤝', 1);
  const brief = page(planning, demo, 'Project brief', '🎯', 2);
  const structure = page(design, sam, 'Site structure', '🧭', 1);
  const checklistPage = page(launchPrep, demo, 'Launch checklist', '🚀', 1);

  const tag = (name: string) => (one<{ id: string }>('SELECT id FROM tags WHERE workspace_id = ? AND name = ?', team, name) ?? { id: undefined }).id;
  const newTag = (name: string, color: string) => {
    const id = newId();
    db.prepare('INSERT INTO tags (id, workspace_id, name, color, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, team, name, color, demo, now());
    return id;
  };
  const designTag = newTag('Design', '#ec4899');
  const contentTag = newTag('Content', '#0ea5e9');
  const staff = (one<{ id: string }>("SELECT id FROM teams WHERE workspace_id = ? AND name = 'Staff'", team) ?? { id: undefined }).id;

  const copy = createTask(demo, team, { title: 'Rewrite the homepage copy', pageId: kickoff, assigneeId: demo, dueDate: addDays(t, 1), priority: 2, tagIds: [contentTag], teamId: staff });
  const mock = createTask(demo, team, { title: 'Share homepage mock-ups', pageId: kickoff, assigneeId: sam, dueDate: addDays(t, 3), priority: 1, tagIds: [designTag] });
  const photos = createTask(demo, team, { title: 'Book the photographer', pageId: kickoff, assigneeId: demo, dueDate: addDays(t, 6), tagIds: [tag('Budget')] });
  const nav = createTask(sam, team, { title: 'Finalise the navigation labels', pageId: structure, assigneeId: sam, dueDate: addDays(t, 2), priority: 2, tagIds: [designTag] });
  createTask(sam, team, { title: 'Collect logos from partners', assigneeId: sam, dueDate: addDays(t, 8), tagIds: [tag('Waiting')] });
  createTask(demo, team, { title: 'Proofread the About page', pageId: checklistPage, assigneeId: demo, dueDate: addDays(t, 5), tagIds: [contentTag] });
  createTask(demo, team, { title: 'Test the contact form on a phone', pageId: checklistPage, assigneeId: sam, dueDate: addDays(t, 9), priority: 3 });
  createTask(demo, team, { title: 'Check last month’s visitor numbers', assigneeId: demo, dueDate: addDays(t, -2), priority: 3 });

  // Kickoff meeting: the "Meeting notes" template, filled in.
  fillBoxes(kickoff, [
    [0, 0, 280, [
      p(bold('Date: '), fmt(t)),
      h(3, 'Attendees'),
      bullets(['Demo User'], ['Sam Teammate'], ['Priya Nair (guest)']),
      h(3, 'Agenda'),
      outline([['Why we’re relaunching'], ['Scope and timeline'], ['Who does what']]),
    ]],
    [310, 0, 380, [
      h(3, 'Notes'),
      p('The current site is hard to use on a phone and the pricing is buried. Goal: a clear homepage, a simple menu and a contact form that works.'),
      h(3, 'Decisions'),
      bullets(['Launch in six weeks'], ['Keep the existing logo and colours'], ['Photos before copy']),
    ]],
    [0, 380, 690, [
      h(3, 'Action items'),
      taskRef(copy.id),
      taskRef(mock.id),
      taskRef(photos.id),
      callout('✅', p('Action items are real tasks: they show on everyone’s dashboard and stay linked to this page.')),
    ]],
  ]);

  // Brief: shared with Priya.
  fillBoxes(brief, [
    [0, 0, 370, [
      callout('🎯', p(bold('Goal: '), 'a faster, friendlier website that turns visitors into enquiries.')),
      h(2, 'Scope'),
      bullets(['New homepage and menu'], ['Pricing page'], ['Contact form and map'], ['Mobile first']),
      h(2, 'Open questions'),
      p('Do we want a blog at launch, or later?'),
      h(2, 'Next steps'),
      outline([['Agree the scope'], ['Approve the mock-ups'], ['Write and photograph', [['Copy'], ['Photos']]]]),
    ]],
    [400, 0, 290, [
      h(2, 'Milestones'),
      table([
        ['Step', 'Owner', 'Due'],
        ['Design', 'Sam', 'Week 2'],
        ['Copy', 'Demo', 'Week 3'],
        ['Build', 'Sam', 'Week 5'],
        ['Launch', 'Everyone', 'Week 6'],
      ]),
    ]],
  ]);
  grantPageShare(brief, priya, true, demo);

  // Numbered outline + table.
  fillBoxes(structure, [
    [0, 0, 330, [
      h(2, 'Menu outline'),
      outline([
        ['Home', [['Hero and call to action'], ['Three highlights'], ['Customer quotes']]],
        ['Services', [['Pricing', [['Starter'], ['Standard']]], ['How it works']]],
        ['About', [['Our story'], ['The team']]],
        ['Contact', [['Form'], ['Map and opening hours']]],
      ]),
      taskRef(nav.id),
    ]],
    [360, 0, 330, [
      h(2, 'Pages and owners'),
      table([
        ['Page', 'Owner', 'Status'],
        ['Home', 'Sam', 'Mock-up'],
        ['Services', 'Demo', 'Drafting'],
        ['About', 'Demo', 'Not started'],
        ['Contact', 'Sam', 'In review'],
      ]),
    ]],
  ]);

  fillBoxes(checklistPage, [
    [0, 0, 560, [
      h(2, 'Before we go live'),
      checklist(['Redirect the old addresses', true], ['Proofread every page', false], ['Check the site on a phone', false], ['Back up the old site', true], ['Tell our newsletter list', false]),
    ]],
  ]);
})();
console.log('extra demo content added');
