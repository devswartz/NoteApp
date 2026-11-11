// Built-in page templates. Content is ProseMirror JSON inserted through the editor (or, on a
// canvas, written into its boxes), so it goes through Yjs like any edit (works offline, syncs to
// collaborators). Each has a document version (`content`) and a canvas version (`boxes`, the
// same sections laid out as text boxes); an empty page offers the version of its own kind.
import type { JSONContent } from '@tiptap/core';

/** A text box of a canvas template: where it sits (page pixels) and what's in it. */
export interface TemplateBox {
  x: number;
  y: number;
  w: number;
  content: JSONContent[];
}

export interface PageTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  /** Title for the new page; `now` lets tests pin the date. */
  title: (now: Date) => string;
  content: (now: Date) => JSONContent[];
  /** The canvas version. */
  boxes: (now: Date) => TemplateBox[];
}

const longDate = (d: Date) => d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const shortDate = (d: Date) => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

const text = (t: string, marks?: JSONContent['marks']): JSONContent => ({ type: 'text', text: t, ...(marks ? { marks } : {}) });
const p = (...content: JSONContent[]): JSONContent => ({ type: 'paragraph', ...(content.length ? { content } : {}) });
const h = (level: 1 | 2 | 3, t: string): JSONContent => ({ type: 'heading', attrs: { level }, content: [text(t)] });
const bullets = (...items: string[]): JSONContent => ({
  type: 'bulletList',
  content: items.map((i) => ({ type: 'listItem', content: [i ? p(text(i)) : p()] })),
});
const numbered = (...items: string[]): JSONContent => ({
  type: 'orderedList',
  content: items.map((i) => ({ type: 'listItem', content: [i ? p(text(i)) : p()] })),
});
const checklist = (...items: string[]): JSONContent => ({
  type: 'taskList',
  content: items.map((i) => ({ type: 'taskItem', attrs: { checked: false }, content: [i ? p(text(i)) : p()] })),
});
const callout = (emoji: string, ...content: JSONContent[]): JSONContent => ({ type: 'callout', attrs: { emoji }, content });
const cell = (t: string, header = false): JSONContent => ({ type: header ? 'tableHeader' : 'tableCell', content: [t ? p(text(t)) : p()] });
const table = (rows: string[][]): JSONContent => ({
  type: 'table',
  content: rows.map((r, i) => ({ type: 'tableRow', content: r.map((c) => cell(c, i === 0)) })),
});
const toggle = (summary: string, ...content: JSONContent[]): JSONContent => ({
  type: 'details',
  content: [
    { type: 'detailsSummary', content: [text(summary)] },
    { type: 'detailsContent', content: content.length ? content : [p()] },
  ],
});
const muted = (t: string) => p(text(t, [{ type: 'italic' }]));
const box = (x: number, y: number, w: number, ...content: JSONContent[]): TemplateBox => ({ x, y, w, content });

export const TEMPLATES: PageTemplate[] = [
  {
    id: 'meeting',
    name: 'Meeting notes',
    description: 'Attendees, agenda, notes and action items',
    icon: '🤝',
    title: (d) => `Meeting · ${shortDate(d)}`,
    content: (d) => [
      p(text('Date: ', [{ type: 'bold' }]), text(longDate(d))),
      h(2, 'Attendees'),
      bullets(''),
      h(2, 'Agenda'),
      numbered(''),
      h(2, 'Notes'),
      p(),
      h(2, 'Decisions'),
      bullets(''),
      h(2, 'Action items'),
      callout('✅', p(text('Type '), text('/task', [{ type: 'code' }]), text(' for a task, or select lines and press Ctrl+Enter (⌘↵ on a Mac). Action items land on everyone’s dashboard.'))),
      p(),
    ],
    boxes: (d) => [
      box(0, 0, 340, p(text('Date: ', [{ type: 'bold' }]), text(longDate(d))), h(3, 'Attendees'), bullets(''), h(3, 'Agenda'), numbered('')),
      box(380, 0, 460, h(3, 'Notes'), p(), h(3, 'Decisions'), bullets('')),
      box(0, 360, 840, h(3, 'Action items'), callout('✅', p(text('Type '), text('/task', [{ type: 'code' }]), text(' for a task. Action items land on everyone’s dashboard.'))), p()),
    ],
  },
  {
    id: 'project',
    name: 'Project',
    description: 'Goal, scope, milestones and open questions',
    icon: '🎯',
    title: () => 'New project',
    content: () => [
      callout('🎯', p(text('Goal: ', [{ type: 'bold' }]), text('what does success look like?'))),
      h(2, 'Overview'),
      muted('Why are we doing this, and for whom?'),
      h(2, 'Scope'),
      table([
        ['In scope', 'Out of scope'],
        ['', ''],
      ]),
      h(2, 'Milestones'),
      table([
        ['Milestone', 'Owner', 'Target date'],
        ['', '', ''],
        ['', '', ''],
      ]),
      h(2, 'Tasks'),
      muted('Type /task to add a task, with dates and owners: “Draft spec friday p2 @sam”.'),
      p(),
      h(2, 'Open questions'),
      bullets(''),
      h(2, 'Links'),
      bullets(''),
    ],
    boxes: () => [
      box(0, 0, 840, callout('🎯', p(text('Goal: ', [{ type: 'bold' }]), text('what does success look like?'))), muted('Why are we doing this, and for whom?')),
      box(0, 180, 400, h(3, 'Scope'), table([
        ['In scope', 'Out of scope'],
        ['', ''],
      ])),
      box(440, 180, 400, h(3, 'Milestones'), table([
        ['Milestone', 'Target date'],
        ['', ''],
        ['', ''],
      ])),
      box(0, 480, 400, h(3, 'Tasks'), muted('Type /task to add a task: “Draft spec friday p2 @sam”.'), p()),
      box(440, 480, 400, h(3, 'Open questions'), bullets(''), h(3, 'Links'), bullets('')),
    ],
  },
  {
    id: 'journal',
    name: 'Daily journal',
    description: 'Focus, notes and a short review',
    icon: '📓',
    title: (d) => longDate(d),
    content: () => [
      h(2, 'Top 3 today'),
      checklist('', '', ''),
      h(2, 'Notes'),
      p(),
      h(2, 'Grateful for'),
      bullets(''),
      toggle('End-of-day review', p(text('What went well? What would I change?', [{ type: 'italic' }]))),
    ],
    boxes: () => [
      box(0, 0, 320, h(3, 'Top 3 today'), checklist('', '', '')),
      box(360, 0, 480, h(3, 'Notes'), p()),
      box(0, 240, 320, h(3, 'Grateful for'), bullets('')),
      box(0, 440, 320, toggle('End-of-day review', p(text('What went well? What would I change?', [{ type: 'italic' }])))),
    ],
  },
];

export const templateById = (id: string) => TEMPLATES.find((t) => t.id === id);
