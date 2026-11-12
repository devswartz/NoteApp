// Fills an EXISTING account with friendly demo content, for the App Store review account.
// Uses only the public API (REST plus the /collab WebSocket), as that user. It does not create
// accounts. Safe to run twice: notebooks, sections, pages, tags and tasks are matched by name
// and skipped if they exist, and a page's content is only written when the page is still empty.
//
//   BASE_URL=https://notes.devswartz.com REVIEW_EMAIL=... REVIEW_PASSWORD=... \
//     [SHARE_WITH_EMAIL=...] npx tsx scripts/seed-review-account.ts
//
// Content goes into the account's own (first owned) workspace: a "Projects" notebook with
// Planning, Design and Launch prep sections, a meeting-notes page laid out like the Meeting
// notes template, a page with a numbered outline and a table, a checklist page, tags, and tasks
// with due dates. With SHARE_WITH_EMAIL, the project brief is shared (can edit) with that person.
import WebSocket from 'ws';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';

const BASE = (process.env.BASE_URL ?? '').replace(/\/+$/, '');
const EMAIL = process.env.REVIEW_EMAIL ?? '';
const PASSWORD = process.env.REVIEW_PASSWORD ?? '';
const SHARE_WITH = process.env.SHARE_WITH_EMAIL ?? '';
if (!BASE || !EMAIL || !PASSWORD) {
  console.error('Set BASE_URL, REVIEW_EMAIL and REVIEW_PASSWORD (and optionally SHARE_WITH_EMAIL).');
  process.exit(1);
}

let token = '';
async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : null) as T;
}

const day = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const longDate = () => new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

// ───────── Yjs builders (ProseMirror-shaped XML, as the editor stores it) ─────────
type Inl = string | { text: string; marks: Record<string, object> };
function inline(parts: Inl[]) {
  const t = new Y.XmlText();
  let i = 0;
  for (const p of parts) {
    const [s, marks] = typeof p === 'string' ? [p, {}] : [p.text, p.marks];
    t.insert(i, s, marks);
    i += s.length;
  }
  return [t];
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
const bullets = (...items: string[]) => el('bulletList', {}, items.map((i) => el('listItem', {}, [p(i)])));
type Item = [string, Item[]?];
const outline = (items: Item[]): Y.XmlElement =>
  el('orderedList', {}, items.map(([t, kids]) => el('listItem', {}, [p(t), ...(kids ? [outline(kids)] : [])])));
const checklist = (...items: [string, boolean][]) => el('taskList', {}, items.map(([t, c]) => el('taskItem', { checked: c }, [p(t)])));
const callout = (emoji: string, ...blocks: Y.XmlElement[]) => el('callout', { emoji }, blocks);
const taskRef = (taskId: string) => el('taskRef', { taskId });
const cell = (s: string, header = false) => el(header ? 'tableHeader' : 'tableCell', {}, [p(s)]);
const table = (rows: string[][]) => el('table', {}, rows.map((r, i) => el('tableRow', {}, r.map((c) => cell(c, i === 0)))));

/** A canvas page: boxes are [x, y, width, blocks] (page pixels; a phone stacks them). */
type Box = [number, number, number, Y.XmlElement[]];

/** Open the page's collab room as this user, write the boxes into an empty page, and wait for the server to save. */
async function writePage(pageId: string, boxes: Box[]): Promise<boolean> {
  const wsUrl = BASE.replace(/^http/, 'ws') + '/collab';
  const doc = new Y.Doc();
  class Authed extends WebSocket {
    constructor(url: string | URL) {
      super(url, ["noteapp.v1", `bearer.${token}`]);
    }
  }
  const provider = new WebsocketProvider(wsUrl, pageId, doc, { WebSocketPolyfill: Authed as unknown as typeof globalThis.WebSocket });
  try {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`collab sync timed out for page ${pageId}`)), 15000);
      provider.on('sync', (ok: boolean) => {
        if (ok) {
          clearTimeout(t);
          resolve();
        }
      });
    });
    const map = doc.getMap<unknown>('boxes');
    if (map.size > 0) return false; // someone already wrote here
    doc.transact(() => {
      boxes.forEach(([x, y, w, blocks], i) => {
        const id = Math.random().toString(16).slice(2, 10) + Math.random().toString(16).slice(2, 10);
        doc.getXmlFragment(`box:${id}`).insert(0, blocks);
        const g = new Y.Map<unknown>();
        g.set('x', x);
        g.set('y', y);
        g.set('w', w);
        g.set('z', i + 1);
        map.set(id, g);
      });
    });
    await new Promise((r) => setTimeout(r, 2500)); // the server saves a room 1 s after its last update
    return true;
  } finally {
    provider.destroy();
    doc.destroy();
  }
}

type Tree = { notebooks: { id: string; name: string }[]; sections: { id: string; notebookId: string; name: string }[]; pages: { id: string; sectionId: string; title: string }[] };

async function main() {
  const session = await api<{ accessToken: string; user: { id: string } }>('POST', '/auth/login', { email: EMAIL, password: PASSWORD });
  token = session.accessToken;
  const me = session.user.id;
  const workspaces = await api<{ id: string; name: string; role: string }[]>('GET', '/workspaces');
  const ws = workspaces.find((w) => w.role === 'owner') ?? workspaces[0];
  if (!ws) throw new Error('This account has no workspace');
  console.log(`Seeding workspace "${ws.name}"`);

  let tree = await api<Tree>('GET', `/workspaces/${ws.id}/tree`);
  const created: string[] = [];

  // Notebook and sections. A new notebook starts with a "General" section, which becomes "Planning".
  let nb = tree.notebooks.find((n) => n.name === 'Projects');
  let firstSection: string | undefined;
  if (!nb) {
    const r = await api<{ id: string; sectionId: string }>('POST', `/workspaces/${ws.id}/notebooks`, { name: 'Projects', color: '#6366f1' });
    nb = { id: r.id, name: 'Projects' };
    firstSection = r.sectionId;
    created.push('notebook Projects');
  }
  const sectionId = async (name: string, color: string) => {
    const existing = tree.sections.find((s) => s.notebookId === nb!.id && s.name === name);
    if (existing) return existing.id;
    if (firstSection) {
      const id = firstSection;
      firstSection = undefined;
      await api('PATCH', `/sections/${id}`, { name, color });
      created.push(`section ${name}`);
      return id;
    }
    const r = await api<{ id: string }>('POST', `/notebooks/${nb!.id}/sections`, { name, color });
    created.push(`section ${name}`);
    return r.id;
  };
  const planning = await sectionId('Planning', '#6366f1');
  const design = await sectionId('Design', '#8b5cf6');
  const launch = await sectionId('Launch prep', '#f59e0b');
  tree = await api<Tree>('GET', `/workspaces/${ws.id}/tree`);

  // Pages: [section, title, icon]. Content is written only for pages created now.
  const pageIds: Record<string, { id: string; isNew: boolean }> = {};
  const ensurePage = async (section: string, title: string, icon: string) => {
    const existing = tree.pages.find((x) => x.sectionId === section && x.title === title);
    if (existing) return (pageIds[title] = { id: existing.id, isNew: false });
    const r = await api<{ id: string }>('POST', `/sections/${section}/pages`, { title });
    await api('PATCH', `/pages/${r.id}`, { icon });
    created.push(`page ${title}`);
    return (pageIds[title] = { id: r.id, isNew: true });
  };
  await ensurePage(planning, 'Kickoff meeting', '🤝');
  await ensurePage(planning, 'Project brief', '🎯');
  await ensurePage(design, 'Site structure', '🧭');
  await ensurePage(launch, 'Launch checklist', '🚀');

  // Tags and tasks, matched by name / title.
  const tags = await api<{ id: string; name: string }[]>('GET', `/workspaces/${ws.id}/tags`);
  const tag = async (name: string, color: string) => (tags.find((t) => t.name.toLowerCase() === name.toLowerCase()) ?? (await api<{ id: string }>('POST', `/workspaces/${ws.id}/tags`, { name, color }))).id;
  const designTag = await tag('Design', '#ec4899');
  const contentTag = await tag('Content', '#0ea5e9');
  const budgetTag = await tag('Budget', '#8b5cf6');

  const existingTasks = await api<{ id: string; title: string }[]>('GET', `/workspaces/${ws.id}/tasks`);
  const taskId = async (title: string, extra: Record<string, unknown>) => {
    const t = existingTasks.find((x) => x.title === title);
    if (t) return t.id;
    const r = await api<{ id: string }>('POST', `/workspaces/${ws.id}/tasks`, { title, assigneeId: me, ...extra });
    created.push(`task ${title}`);
    return r.id;
  };
  const copy = await taskId('Rewrite the homepage copy', { pageId: pageIds['Kickoff meeting'].id, dueDate: day(1), priority: 2, tagIds: [contentTag] });
  const mock = await taskId('Share homepage mock-ups', { pageId: pageIds['Kickoff meeting'].id, dueDate: day(3), priority: 1, tagIds: [designTag] });
  const photos = await taskId('Book the photographer', { pageId: pageIds['Kickoff meeting'].id, dueDate: day(6), tagIds: [budgetTag] });
  const nav = await taskId('Finalise the navigation labels', { pageId: pageIds['Site structure'].id, dueDate: day(2), priority: 2, tagIds: [designTag] });
  await taskId('Proofread the About page', { pageId: pageIds['Launch checklist'].id, dueDate: day(5), tagIds: [contentTag] });
  await taskId('Test the contact form on a phone', { pageId: pageIds['Launch checklist'].id, dueDate: day(9), priority: 3 });
  await taskId('Check last month’s visitor numbers', { dueDate: day(-2), priority: 3 });
  await taskId('Plan the team lunch', { dueDate: day(4), recurrence: { freq: 'week', interval: 1 } });

  // Page content (only into pages that are still empty).
  const fill = async (title: string, boxes: Box[]) => {
    if (await writePage(pageIds[title].id, boxes)) created.push(`content ${title}`);
  };
  await fill('Kickoff meeting', [
    [0, 0, 280, [p(bold('Date: '), longDate()), h(3, 'Attendees'), bullets('You', 'Jordan Lee', 'Priya Shah'), h(3, 'Agenda'), outline([['Why we’re relaunching'], ['Scope and timeline'], ['Who does what']])]],
    [310, 0, 380, [
      h(3, 'Notes'),
      p('The current site is hard to use on a phone and the pricing is buried. Goal: a clear homepage, a simple menu and a contact form that works.'),
      h(3, 'Decisions'),
      bullets('Launch in six weeks', 'Keep the existing logo and colours', 'Photos before copy'),
    ]],
    [0, 380, 690, [h(3, 'Action items'), taskRef(copy), taskRef(mock), taskRef(photos), callout('✅', p('Action items are real tasks: they show on your dashboard and stay linked to this page.'))]],
  ]);
  await fill('Project brief', [
    [0, 0, 370, [
      callout('🎯', p(bold('Goal: '), 'a faster, friendlier website that turns visitors into enquiries.')),
      h(2, 'Scope'),
      bullets('New homepage and menu', 'Pricing page', 'Contact form and map', 'Mobile first'),
      h(2, 'Next steps'),
      outline([['Agree the scope'], ['Approve the mock-ups'], ['Write and photograph', [['Copy'], ['Photos']]]]),
    ]],
    [400, 0, 290, [h(2, 'Milestones'), table([['Step', 'Owner', 'Due'], ['Design', 'Jordan', 'Week 2'], ['Copy', 'You', 'Week 3'], ['Build', 'Jordan', 'Week 5'], ['Launch', 'Everyone', 'Week 6']])]],
  ]);
  await fill('Site structure', [
    [0, 0, 330, [h(2, 'Menu outline'), outline([
      ['Home', [['Hero and call to action'], ['Three highlights'], ['Customer quotes']]],
      ['Services', [['Pricing', [['Starter'], ['Standard']]], ['How it works']]],
      ['About', [['Our story'], ['The team']]],
      ['Contact', [['Form'], ['Map and opening hours']]],
    ]), taskRef(nav)]],
    [360, 0, 330, [h(2, 'Pages and owners'), table([['Page', 'Owner', 'Status'], ['Home', 'Jordan', 'Mock-up'], ['Services', 'You', 'Drafting'], ['About', 'You', 'Not started'], ['Contact', 'Jordan', 'In review']])]],
  ]);
  await fill('Launch checklist', [
    [0, 0, 560, [h(2, 'Before we go live'), checklist(['Redirect the old addresses', true], ['Proofread every page', false], ['Check the site on a phone', false], ['Back up the old site', true], ['Tell our newsletter list', false])]],
  ]);

  // Share the brief with a second account, if given. Sharing again just updates the same share.
  if (SHARE_WITH) {
    const r = await api<{ status: string }>('POST', `/pages/${pageIds['Project brief'].id}/shares`, { email: SHARE_WITH, canEdit: true });
    created.push(`share Project brief (${r.status})`);
  }

  console.log(created.length ? `Created or updated:\n- ${created.join('\n- ')}` : 'Everything already exists; nothing changed.');
}

main().then(
  () => {
    process.exitCode = 0;
  },
  (e) => {
    console.error(String(e?.message ?? e));
    process.exitCode = 1;
  },
);
