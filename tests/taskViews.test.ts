// Dashboard view logic (src/lib/taskViews.ts) and quick add parsing. Owner: Tasks & Dashboard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, today } from '../shared/dates.ts';
import { parseQuickAdd } from '../shared/quickadd.ts';
import { DEFAULT_FILTERS, applyFilters, groupBy, isMine, sortTasks, todayGroups, upcomingGroups } from '../src/lib/taskViews.ts';
import type { Task, Tree } from '../shared/types.ts';

/** A filter condition: any of these values, or (not: true) none of them. */
const pk = (v: string, ...more: string[]) => ({ values: [v, ...more], not: false });
const notPk = (v: string, ...more: string[]) => ({ values: [v, ...more], not: true });

const ME = 'me';
let seq = 0;
function task(p: Partial<Task> = {}): Task {
  const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, seq++)).toISOString();
  return {
    id: `t${seq}`, workspaceId: 'w', title: `Task ${seq}`, description: '', status: 'open', priority: 4,
    dueDate: null, dueTime: null, recurrence: null, reminderAt: null, assigneeId: ME, createdBy: ME,
    pageId: null, parentId: null, teamId: null, tagIds: [], assignedBy: null, completedAt: null, completedBy: null, createdAt: ts, updatedAt: ts, ...p,
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
  assert.deepEqual(f({ assignee: pk('sam') }), [standalone.id]);
  assert.deepEqual(f({ priority: pk('1') }), [inNote.id]);
  assert.deepEqual(f({ due: 'overdue' }), [inNote.id]);
  assert.deepEqual(f({ due: 'week' }), [inNote.id, standalone.id]);
  assert.deepEqual(f({ notebookId: pk('nb1') }), [inNote.id]);
  assert.deepEqual(f({ source: pk('standalone') }), [standalone.id]);
  assert.deepEqual(f({ status: 'done' }), [done.id]);
  assert.deepEqual(f({ status: 'any', source: pk('standalone') }), [standalone.id, done.id]);
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
  const { parseSavedViews, sameView } = await import('../src/pages/tasks/savedViewsCore.ts');
  assert.deepEqual(parseSavedViews(null), []);
  assert.deepEqual(parseSavedViews('not json'), []);
  assert.deepEqual(parseSavedViews('{"a":1}'), []);
  const [v] = parseSavedViews(JSON.stringify([{ id: 'v1', name: 'Mine, urgent', filters: { assignee: 'me', priority: '1', bogus: 'x' }, sort: 'evil', group: 'priority' }, { name: 'no id' }]));
  assert.equal(v.name, 'Mine, urgent');
  assert.equal(v.sort, 'due', 'unknown sort falls back');
  assert.equal(v.group, 'priority');
  assert.deepEqual(v.filters.assignee, { values: ['me'], not: false }, 'a single value saved by an older version becomes a list');
  assert.equal(v.filters.status, 'open', 'missing filters get defaults');
  assert.ok(!('bogus' in v.filters));
  assert.ok(sameView(v, { ...DEFAULT_FILTERS, assignee: pk('me'), priority: pk('1') }, 'due', 'priority'));
  assert.ok(!sameView(v, DEFAULT_FILTERS, 'due', 'priority'));
});

test('saved views: the heading names the view the link opened, or an exact non-empty match', async () => {
  const { openedView } = await import('../src/pages/tasks/savedViewsCore.ts');
  const mk = (id: string, name: string, filters = DEFAULT_FILTERS) => ({ id, name, filters, sort: 'due' as const, group: 'none' as const, shared: false, ownerId: 'u', position: 0 });
  const urgent = mk('a', 'Urgent', { ...DEFAULT_FILTERS, priority: pk('1') });
  const empty = mk('b', 'Everything');
  const views = [urgent, empty];
  assert.equal(openedView(views, 'a', DEFAULT_FILTERS, 'due', 'none')?.name, 'Urgent', 'the link wins, even once its filters were edited');
  assert.equal(openedView(views, null, urgent.filters, 'due', 'none')?.name, 'Urgent', 'an exact match names it');
  assert.equal(openedView(views, null, DEFAULT_FILTERS, 'due', 'none'), undefined, 'plain All Tasks is not mistaken for a view with no filters');
  assert.equal(openedView(views, 'gone', DEFAULT_FILTERS, 'due', 'none'), undefined, 'a deleted view falls back to All Tasks');
});

test('filters: tags (any / none), teams with and without subteams, assigned by, section', async () => {
  const { normalizeFilters, activeFilterKeys } = await import('../src/lib/taskViews.ts');
  const teams = [
    { id: 'elders', workspaceId: 'w', parentId: null, name: 'Elders', color: '#000000', position: 1, memberIds: [] },
    { id: 'shep', workspaceId: 'w', parentId: 'elders', name: 'Shepherds', color: '#000000', position: 2, memberIds: [] },
    { id: 'staff', workspaceId: 'w', parentId: null, name: 'Staff', color: '#000000', position: 3, memberIds: [] },
  ];
  const a = task({ title: 'a', teamId: 'elders', tagIds: ['waiting'], assigneeId: 'scott', assignedBy: ME });
  const b = task({ title: 'b', teamId: 'shep', tagIds: ['budget'], assigneeId: 'scott', assignedBy: 'scott' });
  const c = task({ title: 'c', teamId: 'staff', assigneeId: 'scott', assignedBy: ME, pageId: 'p1' });
  const d = task({ title: 'd', assigneeId: ME, assignedBy: ME });
  const e = task({ title: 'e', teamId: 'elders', assigneeId: null });
  const all = [a, b, c, d, e];
  const run = (f: Partial<typeof DEFAULT_FILTERS>) => applyFilters(all, { ...DEFAULT_FILTERS, ...f }, ME, tree, teams).map((x) => x.title).sort();
  assert.deepEqual(run({ tagsAny: ['waiting', 'budget'] }), ['a', 'b']);
  assert.deepEqual(run({ tagsNone: ['waiting'] }), ['b', 'c', 'd', 'e']);
  assert.deepEqual(run({ teamId: pk('elders') }), ['a', 'b', 'e'], 'subteams included by default');
  assert.deepEqual(run({ teamId: pk('elders'), includeSubteams: false }), ['a', 'e']);
  assert.deepEqual(run({ teamId: pk('none') }), ['d']);
  // The tester's four views.
  assert.deepEqual(run({ teamId: pk('elders'), status: 'open' }), ['a', 'b', 'e'], 'all unfinished Elders tasks');
  assert.deepEqual(run({ assignee: pk('scott') }), ['a', 'b', 'c'], 'everything assigned to Scott, across teams');
  assert.deepEqual(run({ teamId: pk('elders'), assignee: pk('scott') }), ['a', 'b'], 'Scott’s Elders tasks (not his Staff one)');
  assert.deepEqual(run({ assignedBy: pk('me'), assignee: pk('others') }), ['a', 'c'], 'tasks I assigned to others');
  assert.deepEqual(run({ sectionId: pk('s1') }), ['c']);
  // Saved filters are normalised: arrays and booleans kept, junk dropped.
  const n = normalizeFilters({ tagsAny: ['x', 3], includeSubteams: false, priority: 'p9', teamId: 'elders', bogus: 1 });
  assert.deepEqual(n.tagsAny, ['x']);
  assert.equal(n.includeSubteams, false);
  assert.deepEqual(n.priority, { values: [], not: false });
  assert.deepEqual(n.teamId, { values: ['elders'], not: false }, 'one value from an older version becomes a list');
  assert.deepEqual(activeFilterKeys(n).sort(), ['tagsAny', 'teamId']);
});

test('filters: several values per condition, and "is not"', async () => {
  const { normalizeFilters, sameFilters, activeFilterKeys } = await import('../src/lib/taskViews.ts');
  const mk = (title: string, assigneeId: string | null, priority: 1 | 2 | 3 | 4 = 4) => task({ title, assigneeId, priority });
  const bob = mk('bob', 'bob', 1);
  const amy = mk('amy', 'amy', 2);
  const tom = mk('tom', 'tom', 3);
  const mike = mk('mike', 'mike', 1);
  const nobody = mk('nobody', null);
  const all = [bob, amy, tom, mike, nobody];
  const run = (f: Partial<typeof DEFAULT_FILTERS>) => applyFilters(all, { ...DEFAULT_FILTERS, ...f }, ME, tree).map((x) => x.title).sort();
  assert.deepEqual(run({ assignee: pk('bob', 'amy', 'tom') }), ['amy', 'bob', 'tom'], 'any of several, so Mike stays out');
  assert.deepEqual(run({ assignee: notPk('mike') }), ['amy', 'bob', 'nobody', 'tom'], 'everyone but Mike, and unassigned tasks stay');
  assert.deepEqual(run({ assignee: notPk('unassigned', 'mike') }), ['amy', 'bob', 'tom']);
  assert.deepEqual(run({ assignee: notPk('mike'), priority: pk('1', '2') }), ['amy', 'bob'], 'conditions combine with AND');
  assert.deepEqual(run({ priority: notPk('1') }), ['amy', 'nobody', 'tom']);
  assert.deepEqual(run({ assignee: { values: [], not: true } }).length, 5, 'no values: the condition is off');
  // Stored and round-tripped.
  const f = { ...DEFAULT_FILTERS, assignee: notPk('mike', 'tom'), priority: pk('1') };
  const back = normalizeFilters(JSON.parse(JSON.stringify(f)));
  assert.ok(sameFilters(back, f));
  assert.ok(!sameFilters(back, { ...f, assignee: pk('mike', 'tom') }), 'is and is not differ');
  assert.ok(sameFilters(normalizeFilters({ assignee: { values: ['b', 'a'], not: false } }), { ...DEFAULT_FILTERS, assignee: pk('a', 'b') }), 'order does not matter');
  assert.deepEqual(activeFilterKeys(f), ['assignee', 'priority']);
});

test('quick add: #tags and +team', () => {
  const r = parseQuickAdd('Book the hall #waiting #Budget tomorrow +elders #waiting #123');
  assert.deepEqual(r.tags, ['waiting', 'Budget']);
  assert.equal(r.team, 'elders');
  assert.equal(r.title, 'Book the hall #123');
  assert.ok(r.dueDate);
  assert.ok(r.tokens.some((t) => t.kind === 'team'));
  assert.equal(r.tokens.filter((t) => t.kind === 'tag').length, 3);
  const plain = parseQuickAdd('C++ and a+b stay as they are');
  assert.equal(plain.team, null);
  assert.equal(plain.title, 'C++ and a+b stay as they are');
});
