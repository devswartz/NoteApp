// Dashboard view logic (src/lib/taskViews.ts) and quick add parsing. Owner: Tasks & Dashboard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, today } from '../shared/dates.ts';
import { parseQuickAdd } from '../shared/quickadd.ts';
import { DEFAULT_FILTERS, applyFilters, groupBy, isMine, sortTasks, todayGroups, upcomingGroups } from '../src/lib/taskViews.ts';
import type { Task, Tree } from '../shared/types.ts';

const ME = 'me';
let seq = 0;
function task(p: Partial<Task> = {}): Task {
  const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, seq++)).toISOString();
  return {
    id: `t${seq}`, workspaceId: 'w', title: `Task ${seq}`, description: '', status: 'open', priority: 4,
    dueDate: null, dueTime: null, recurrence: null, reminderAt: null, assigneeId: ME, createdBy: ME,
    pageId: null, parentId: null, completedAt: null, completedBy: null, createdAt: ts, updatedAt: ts, ...p,
  };
}
const T = today();
const tree: Tree = {
  notebooks: [{ id: 'nb1', workspaceId: 'w', name: 'Work', color: '', visibility: 'shared', createdBy: ME, position: 1 }],
  sections: [{ id: 's1', notebookId: 'nb1', parentId: null, name: 'S', color: '', position: 1 }],
  pages: [{ id: 'p1', sectionId: 's1', title: 'Roadmap', icon: null, kind: 'document', position: 1, updatedAt: '', updatedBy: null }],
};

test('isMine: assigned to me, or my own unassigned to-dos', () => {
  assert.ok(isMine(task(), ME));
  assert.ok(isMine(task({ assigneeId: null }), ME));
  assert.ok(!isMine(task({ assigneeId: 'sam' }), ME));
  assert.ok(!isMine(task({ assigneeId: null, createdBy: 'sam' }), ME));
});

test('Today shows overdue and due-today tasks of mine only', () => {
  const overdue = task({ dueDate: addDays(T, -2) });
  const due = task({ dueDate: T });
  const later = task({ dueDate: addDays(T, 1) });
  const theirs = task({ dueDate: T, assigneeId: 'sam' });
  const g = todayGroups([overdue, due, later, theirs, task()], ME);
  assert.deepEqual(g.map((x) => x.key), ['overdue', 'today']);
  assert.deepEqual(g[0].tasks, [overdue]);
  assert.deepEqual(g[1].tasks, [due]);
});

test('Upcoming groups by date with overdue first and later last', () => {
  const a = task({ dueDate: addDays(T, 3) });
  const b = task({ dueDate: addDays(T, 30) });
  const c = task({ dueDate: addDays(T, -1) });
  const g = upcomingGroups([a, b, c, task()]);
  assert.equal(g[0].key, 'overdue');
  assert.equal(g.at(-1)!.key, 'later');
  assert.deepEqual(g.find((x) => x.key === addDays(T, 3))!.tasks, [a]);
  assert.equal(g.filter((x) => x.dueDate).length, 14);
});

test('sorting by due puts undated last and breaks ties by time then priority', () => {
  const a = task({ dueDate: T, dueTime: '15:00' });
  const b = task({ dueDate: T, dueTime: '09:00' });
  const c = task({ dueDate: T, priority: 1 });
  const d = task();
  assert.deepEqual(sortTasks([d, c, a, b]).map((x) => x.id), [b, a, c, d].map((x) => x.id));
  assert.deepEqual(sortTasks([d, c], 'priority').map((x) => x.id), [c.id, d.id]);
});

test('Team grouping by assignee puts Unassigned last', () => {
  const members = [{ id: ME, name: 'Me' }, { id: 'sam', name: 'Sam' }];
  const g = groupBy([task({ assigneeId: null }), task({ assigneeId: 'sam' }), task()], 'assignee', 'due', { members, tree });
  assert.deepEqual(g.map((x) => x.label), ['Me', 'Sam', 'Unassigned']);
});

test('All-view filters: text, assignee, priority, due, notebook, status', () => {
  const inNote = task({ title: 'Ship roadmap', pageId: 'p1', priority: 1, dueDate: addDays(T, -1) });
  const standalone = task({ title: 'Call Sam', assigneeId: 'sam', dueDate: addDays(T, 5) });
  const done = task({ title: 'Old', status: 'done' });
  const all = [inNote, standalone, done];
  const f = (p: Partial<typeof DEFAULT_FILTERS>) => applyFilters(all, { ...DEFAULT_FILTERS, ...p }, ME, tree).map((x) => x.id);
  assert.deepEqual(f({ q: 'roadmap' }), [inNote.id]);
  assert.deepEqual(f({ assignee: 'sam' }), [standalone.id]);
  assert.deepEqual(f({ priority: '1' }), [inNote.id]);
  assert.deepEqual(f({ due: 'overdue' }), [inNote.id]);
  assert.deepEqual(f({ due: 'week' }), [inNote.id, standalone.id]);
  assert.deepEqual(f({ notebookId: 'nb1' }), [inNote.id]);
  assert.deepEqual(f({ source: 'standalone' }), [standalone.id]);
  assert.deepEqual(f({ status: 'done' }), [done.id]);
  assert.deepEqual(f({ status: 'any', source: 'standalone' }), [standalone.id, done.id]);
});

const NOW = new Date(2026, 10, 5, 9, 0); // Thu 5 Nov 2026

test('quick add: "Call Sam tomorrow 3pm p1 @devon"', () => {
  const r = parseQuickAdd('Call Sam tomorrow 3pm p1 @devon', NOW);
  assert.equal(r.title, 'Call Sam');
  assert.equal(r.dueDate, '2026-11-06');
  assert.equal(r.dueTime, '15:00');
  assert.equal(r.priority, 1);
  assert.equal(r.assignee, 'devon');
});

test('quick add: connectors, noon, relative and absolute dates, recurrence', () => {
  assert.deepEqual(pick(parseQuickAdd('Ship v2 by 2026-12-01', NOW)), ['Ship v2', '2026-12-01', null]);
  assert.deepEqual(pick(parseQuickAdd('Lunch with Ana at noon', NOW)), ['Lunch with Ana', '2026-11-05', '12:00']);
  assert.deepEqual(pick(parseQuickAdd('Report due friday', NOW)), ['Report', '2026-11-06', null]);
  assert.deepEqual(pick(parseQuickAdd('Email Bob in 3 days', NOW)), ['Email Bob', '2026-11-08', null]);
  assert.deepEqual(pick(parseQuickAdd('Dinner Nov 20 7:30pm', NOW)), ['Dinner', '2026-11-20', '19:30']);
  const r = parseQuickAdd('Standup every weekday 9:15am', NOW);
  assert.deepEqual(r.recurrence, { freq: 'weekday' });
  assert.equal(r.dueTime, '09:15');
  assert.equal(parseQuickAdd('Plain words only', NOW).dueDate, null);
});

function pick(r: ReturnType<typeof parseQuickAdd>) {
  return [r.title, r.dueDate, r.dueTime];
}

test('productivity: done today, tasks left, streak and week', async () => {
  const { productivity } = await import('../src/lib/taskViews.ts');
  const now = new Date(2026, 10, 5, 15, 0);
  const at = (daysAgo: number) => new Date(2026, 10, 5 - daysAgo, 10, 0).toISOString();
  const done = (daysAgo: number, by = ME) => task({ status: 'done', completedBy: by, completedAt: at(daysAgo) });
  const list = [done(0), done(0), done(1), done(2), done(4), done(0, 'sam'), task({ dueDate: '2026-11-04' }), task({ dueDate: '2026-11-05' }), task({ dueDate: '2026-11-06' })];
  const p = productivity(list, ME, now);
  assert.equal(p.doneToday, 2);
  assert.equal(p.left, 2);
  assert.equal(p.streak, 3, 'today, yesterday, the day before; the gap at 3 days ago ends it');
  assert.deepEqual(p.week, [0, 0, 1, 0, 1, 1, 2]);
  // Nothing yet today: the streak still counts up to yesterday.
  assert.equal(productivity([done(1), done(2)], ME, now).streak, 2);
});

test('saved views: stored JSON is parsed defensively', async () => {
  const { parseSavedViews, sameView } = await import('../src/pages/tasks/savedViews.ts');
  assert.deepEqual(parseSavedViews(null), []);
  assert.deepEqual(parseSavedViews('not json'), []);
  assert.deepEqual(parseSavedViews('{"a":1}'), []);
  const [v] = parseSavedViews(JSON.stringify([{ id: 'v1', name: 'Mine, urgent', filters: { assignee: 'me', priority: '1', bogus: 'x' }, sort: 'evil', group: 'priority' }, { name: 'no id' }]));
  assert.equal(v.name, 'Mine, urgent');
  assert.equal(v.sort, 'due', 'unknown sort falls back');
  assert.equal(v.group, 'priority');
  assert.equal(v.filters.assignee, 'me');
  assert.equal(v.filters.status, 'open', 'missing filters get defaults');
  assert.ok(!('bogus' in v.filters));
  assert.ok(sameView(v, { ...DEFAULT_FILTERS, assignee: 'me', priority: '1' }, 'due', 'priority'));
  assert.ok(!sameView(v, DEFAULT_FILTERS, 'due', 'priority'));
});
