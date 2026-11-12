// Pure functions that derive dashboard views from the task map.
import { addDays, today } from '../../shared/dates.ts';
import type { Task, Team, Tree } from '../../shared/types.ts';
import { describeDue, longDate } from './format.ts';
import { sectionDescendants } from '../../shared/sections.ts';

export type ViewId = 'today' | 'my' | 'upcoming' | 'team' | 'all' | 'calendar' | 'completed';

export const VIEWS: { id: ViewId; label: string; shortcut: string }[] = [
  { id: 'today', label: 'Today', shortcut: 'G T' },
  { id: 'my', label: 'My Tasks', shortcut: 'G M' },
  { id: 'upcoming', label: 'Upcoming', shortcut: 'G U' },
  { id: 'team', label: 'Team', shortcut: 'G E' },
  { id: 'all', label: 'All Tasks', shortcut: 'G A' },
  { id: 'calendar', label: 'Calendar', shortcut: 'G C' },
  { id: 'completed', label: 'Completed', shortcut: 'G D' },
];

export interface Group {
  key: string;
  label: string;
  tone?: 'danger';
  /** Due date the group represents — used when adding a task inside it. */
  dueDate?: string | null;
  assigneeId?: string | null;
  /** Team the group represents (group by team): new tasks added inside it get this team. */
  teamId?: string | null;
  tasks: Task[];
}

/** Assigned to me, or unassigned tasks I created (personal to-dos). */
export const isMine = (t: Task, me: string) => t.assigneeId === me || (!t.assigneeId && t.createdBy === me);

export function sortTasks(list: Task[], by: SortKey = 'due'): Task[] {
  const cmp: Record<SortKey, (a: Task, b: Task) => number> = {
    due: (a, b) =>
      (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') ||
      (a.dueTime ?? '99').localeCompare(b.dueTime ?? '99') ||
      a.priority - b.priority ||
      a.createdAt.localeCompare(b.createdAt),
    priority: (a, b) => a.priority - b.priority || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999'),
    created: (a, b) => b.createdAt.localeCompare(a.createdAt),
    title: (a, b) => a.title.localeCompare(b.title),
  };
  return [...list].sort(cmp[by]);
}

export type SortKey = 'due' | 'priority' | 'created' | 'title';
export type GroupKey = 'none' | 'due' | 'assignee' | 'note' | 'priority' | 'team';

/** Open tasks, plus ones completed a moment ago (so the check animation is visible). */
export function visibleOpen(tasks: Record<string, Task>, lingering: Record<string, true>): Task[] {
  return Object.values(tasks).filter((t) => t.status === 'open' || lingering[t.id]);
}

export function todayGroups(list: Task[], me: string): Group[] {
  const t = today();
  const mine = list.filter((x) => isMine(x, me) && x.dueDate && x.dueDate <= t);
  const overdue = sortTasks(mine.filter((x) => x.dueDate! < t));
  const due = sortTasks(mine.filter((x) => x.dueDate === t));
  const groups: Group[] = [];
  if (overdue.length) groups.push({ key: 'overdue', label: 'Overdue', tone: 'danger', tasks: overdue });
  groups.push({ key: 'today', label: `Today · ${longDate(t)}`, dueDate: t, tasks: due });
  return groups;
}

export function upcomingGroups(list: Task[], days = 14): Group[] {
  const t = today();
  const groups: Group[] = [];
  const overdue = sortTasks(list.filter((x) => x.dueDate && x.dueDate < t));
  if (overdue.length) groups.push({ key: 'overdue', label: 'Overdue', tone: 'danger', tasks: overdue });
  for (let i = 0; i < days; i++) {
    const d = addDays(t, i);
    const label = i < 2 ? `${describeDue(d)} · ${longDate(d)}` : longDate(d);
    groups.push({ key: d, label, dueDate: d, tasks: sortTasks(list.filter((x) => x.dueDate === d)) });
  }
  const later = sortTasks(list.filter((x) => x.dueDate && x.dueDate >= addDays(t, days)));
  if (later.length) groups.push({ key: 'later', label: 'Later', tasks: later });
  return groups;
}

export function groupBy(
  list: Task[],
  key: GroupKey,
  sort: SortKey,
  ctx: { members: { id: string; name: string }[]; tree: Tree; teams?: Team[] },
): Group[] {
  const sorted = sortTasks(list, sort);
  if (key === 'none') return [{ key: 'all', label: '', tasks: sorted }];
  const map = new Map<string, Group>();
  const add = (k: string, label: string, t: Task, extra: Partial<Group> = {}) => {
    let g = map.get(k);
    if (!g) map.set(k, (g = { key: k, label, tasks: [], ...extra }));
    g.tasks.push(t);
  };
  const td = today();
  for (const t of sorted) {
    switch (key) {
      case 'due':
        if (!t.dueDate) add('~none', 'No date', t, { dueDate: null });
        else if (t.dueDate < td) add('!overdue', 'Overdue', t, { tone: 'danger' });
        else add(t.dueDate, `${describeDue(t.dueDate)}${t.dueDate <= addDays(td, 1) ? ' · ' + longDate(t.dueDate) : ''}`, t, { dueDate: t.dueDate });
        break;
      case 'assignee': {
        const m = ctx.members.find((x) => x.id === t.assigneeId);
        add(m ? `a${m.name}` : '~', m?.name ?? 'Unassigned', t, { assigneeId: m?.id ?? null });
        break;
      }
      case 'priority':
        add(String(t.priority), t.priority === 4 ? 'No priority' : `Priority ${t.priority}`, t);
        break;
      case 'team': {
        const team = ctx.teams?.find((x) => x.id === t.teamId);
        add(team ? `t${String(teamOrder(team, ctx.teams!)).padStart(5, '0')}` : '~', team ? teamLabel(team, ctx.teams!) : 'No team', t, { teamId: team?.id ?? null });
        break;
      }
      case 'note': {
        const page = ctx.tree.pages.find((p) => p.id === t.pageId);
        add(page ? `p${page.title}${page.id}` : '~', page ? page.title || 'Untitled' : 'Not in a note', t);
        break;
      }
    }
  }
  return [...map.entries()].sort(([a], [b]) => groupKeyRank(a) - groupKeyRank(b) || a.localeCompare(b)).map(([, g]) => g);
}

/** Group keys starting with "!" sort first (Overdue), "~" last (No date, Unassigned, Not in a note). */
function groupKeyRank(k: string) {
  return k.startsWith('!') ? 0 : k.startsWith('~') ? 2 : 1;
}

/**
 * One filter condition with several values. A task matches when it matches any of the values
 * (or, with `not`, none of them). No values: the condition is off.
 */
export interface Pick {
  values: string[];
  not: boolean;
}

/** The conditions that take a Pick. */
export type PickKey = 'assignee' | 'assignedBy' | 'priority' | 'source' | 'notebookId' | 'sectionId' | 'teamId';
export const PICK_KEYS: PickKey[] = ['assignee', 'assignedBy', 'priority', 'source', 'notebookId', 'sectionId', 'teamId'];

export interface Filters {
  q: string;
  /** Values: me (assigned to me, or my unassigned to-dos), unassigned, others (assigned to someone who isn't me), or a user id. */
  assignee: Pick;
  /** Who set the assignee: me or a user id. */
  assignedBy: Pick;
  /** 1 to 4 (4 is "no priority"). */
  priority: Pick;
  due: 'any' | 'overdue' | 'today' | 'week' | 'none';
  /** notes or standalone. */
  source: Pick;
  notebookId: Pick;
  /** A section (and, once sections nest, its subsections). */
  sectionId: Pick;
  /** The task's own team ('none' = no team); with includeSubteams, a parent team also matches its subteams' tasks. */
  teamId: Pick;
  includeSubteams: boolean;
  /** Has any of these tags (OR). */
  tagsAny: string[];
  /** Has none of these tags. */
  tagsNone: string[];
  status: 'open' | 'done' | 'any';
}

export const NO_PICK: Pick = { values: [], not: false };

export const DEFAULT_FILTERS: Filters = {
  q: '',
  assignee: NO_PICK,
  assignedBy: NO_PICK,
  priority: NO_PICK,
  due: 'any',
  source: NO_PICK,
  notebookId: NO_PICK,
  sectionId: NO_PICK,
  teamId: NO_PICK,
  includeSubteams: true,
  tagsAny: [],
  tagsNone: [],
  status: 'open',
};

const ENUMS = {
  due: ['any', 'overdue', 'today', 'week', 'none'],
  status: ['open', 'done', 'any'],
};

const PICK_VALUES: Partial<Record<PickKey, string[]>> = {
  priority: ['1', '2', '3', '4'],
  source: ['notes', 'standalone'],
};

const strings = (v: unknown, max = 50): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length <= 200).slice(0, max) : []);

/** A Pick from JSON: {values, not}, or what older versions stored, one value ('any' = off). */
function normalizePick(raw: unknown, key: PickKey): Pick {
  let values: string[] = [];
  let not = false;
  if (typeof raw === 'string') values = raw === 'any' || raw.length > 200 ? [] : [raw];
  else if (raw && typeof raw === 'object') {
    values = strings((raw as Record<string, unknown>).values);
    not = (raw as Record<string, unknown>).not === true;
  }
  const allowed = PICK_VALUES[key];
  if (allowed) values = values.filter((v) => allowed.includes(v));
  values = [...new Set(values)];
  return values.length ? { values, not } : NO_PICK;
}

/** Filters from untrusted JSON (saved views, old device storage): unknown fields dropped, bad values defaulted. */
export function normalizeFilters(raw: unknown): Filters {
  const f: Filters = { ...DEFAULT_FILTERS, tagsAny: [], tagsNone: [] };
  if (!raw || typeof raw !== 'object') return f;
  const r = raw as Record<string, unknown>;
  for (const k of PICK_KEYS) f[k] = normalizePick(r[k], k);
  f.tagsAny = strings(r.tagsAny);
  f.tagsNone = strings(r.tagsNone);
  if (typeof r.includeSubteams === 'boolean') f.includeSubteams = r.includeSubteams;
  if (typeof r.q === 'string' && r.q.length <= 200) f.q = r.q;
  if (typeof r.due === 'string' && ENUMS.due.includes(r.due)) f.due = r.due as Filters['due'];
  if (typeof r.status === 'string' && ENUMS.status.includes(r.status)) f.status = r.status as Filters['status'];
  return f;
}

const samePick = (a: Pick, b: Pick) => a.not === b.not && a.values.length === b.values.length && a.values.every((v) => b.values.includes(v));

/** Same conditions? (Value order doesn't matter.) */
export function sameFilters(a: Filters, b: Filters): boolean {
  return (
    PICK_KEYS.every((k) => samePick(a[k], b[k])) &&
    (['q', 'due', 'status', 'includeSubteams'] as const).every((k) => a[k] === b[k]) &&
    (['tagsAny', 'tagsNone'] as const).every((k) => a[k].length === b[k].length && a[k].every((v) => b[k].includes(v)))
  );
}

/** The filter fields that are on (search text, status and subteams are excluded: they have their own controls). */
export function activeFilterKeys(f: Filters): (keyof Filters)[] {
  const keys: (keyof Filters)[] = [];
  for (const k of PICK_KEYS) if (f[k].values.length) keys.push(k);
  if (f.due !== 'any') keys.push('due');
  if (f.tagsAny.length) keys.push('tagsAny');
  if (f.tagsNone.length) keys.push('tagsNone');
  return keys;
}

/** The team ids a team filter matches: the team, plus its subteams when includeSubteams is on. */
export function teamScope(teamId: string, includeSubteams: boolean, teams: Team[]): Set<string> {
  const ids = new Set([teamId]);
  if (includeSubteams) for (const t of teams) if (t.parentId === teamId) ids.add(t.id);
  return ids;
}

export function applyFilters(list: Task[], f: Filters, me: string, tree: Tree, teams: Team[] = []): Task[] {
  const t = today();
  const q = f.q.trim().toLowerCase();
  const sectionNotebook = new Map(tree.sections.map((s) => [s.id, s.notebookId]));
  const pageSection = new Map(tree.pages.map((p) => [p.id, p.sectionId]));
  // Any of the values matches (or, with "not", none does); no values: no condition.
  const matches = (p: Pick, test: (v: string) => boolean) => !p.values.length || p.values.some(test) !== p.not;
  const sectionSets = new Map(f.sectionId.values.map((id) => [id, sectionDescendants(tree, id)]));
  const teamSets = new Map(f.teamId.values.filter((v) => v !== 'none').map((id) => [id, teamScope(id, f.includeSubteams, teams)]));
  const assignedBy = { ...f.assignedBy, values: f.assignedBy.values.map((v) => (v === 'me' ? me : v)) };
  return list.filter((x) => {
    if (f.status !== 'any' && x.status !== f.status) return false;
    if (q && !x.title.toLowerCase().includes(q) && !x.description.toLowerCase().includes(q)) return false;
    if (
      !matches(f.assignee, (v) =>
        v === 'me' ? isMine(x, me) : v === 'unassigned' ? !x.assigneeId : v === 'others' ? !!x.assigneeId && x.assigneeId !== me : x.assigneeId === v,
      )
    )
      return false;
    if (!matches(assignedBy, (v) => x.assignedBy === v)) return false;
    if (!matches(f.priority, (v) => x.priority === Number(v))) return false;
    if (f.due === 'overdue' && !(x.dueDate && x.dueDate < t)) return false;
    if (f.due === 'today' && !(x.dueDate && x.dueDate <= t)) return false;
    if (f.due === 'week' && !(x.dueDate && x.dueDate <= addDays(t, 7))) return false;
    if (f.due === 'none' && x.dueDate) return false;
    if (!matches(f.source, (v) => (v === 'notes' ? !!x.pageId : !x.pageId))) return false;
    const section = x.pageId ? pageSection.get(x.pageId) : undefined;
    if (!matches(f.notebookId, (v) => !!section && sectionNotebook.get(section) === v)) return false;
    if (!matches(f.sectionId, (v) => !!section && !!sectionSets.get(v)?.has(section))) return false;
    if (!matches(f.teamId, (v) => (v === 'none' ? !x.teamId : !!x.teamId && !!teamSets.get(v)?.has(x.teamId)))) return false;
    const tags = x.tagIds ?? [];
    if (f.tagsAny.length && !f.tagsAny.some((id) => tags.includes(id))) return false;
    if (f.tagsNone.length && f.tagsNone.some((id) => tags.includes(id))) return false;
    return true;
  });
}

/** "Staff › Worship" for a subteam, the name for a team. */
export function teamLabel(team: Team, teams: Team[]): string {
  const parent = team.parentId ? teams.find((x) => x.id === team.parentId) : undefined;
  return parent ? `${parent.name} › ${team.name}` : team.name;
}

/** Teams in display order: each team followed by its subteams. */
export function orderedTeams(teams: Team[]): Team[] {
  const byPos = (a: Team, b: Team) => a.position - b.position || a.name.localeCompare(b.name);
  const top = teams.filter((t) => !t.parentId || !teams.some((p) => p.id === t.parentId)).sort(byPos);
  return top.flatMap((t) => [t, ...teams.filter((s) => s.parentId === t.id).sort(byPos)]);
}

function teamOrder(team: Team, teams: Team[]): number {
  return orderedTeams(teams).findIndex((t) => t.id === team.id);
}

export interface MemberStats {
  open: number;
  overdue: number;
  dueToday: number;
  doneThisWeek: number;
}

export function memberStats(all: Task[], memberId: string | null): MemberStats {
  const t = today();
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
  const s: MemberStats = { open: 0, overdue: 0, dueToday: 0, doneThisWeek: 0 };
  for (const x of all) {
    if (x.assigneeId !== memberId) continue;
    if (x.status === 'open') {
      s.open++;
      if (x.dueDate && x.dueDate < t) s.overdue++;
      if (x.dueDate === t) s.dueToday++;
    } else if (x.completedAt && x.completedAt > weekAgo) s.doneThisWeek++;
  }
  return s;
}

export interface Productivity {
  /** Tasks I completed today. */
  doneToday: number;
  /** My open tasks due today or overdue. */
  left: number;
  /** Consecutive days (ending today, or yesterday if nothing is done yet today) with at least one completion by me. */
  streak: number;
  /** Completions per day for the last 7 days, oldest first. */
  week: number[];
}

/** Stats for the strip on Today. Only sees what the client has loaded (30 days of completions). */
export function productivity(all: Task[], me: string, now = new Date()): Productivity {
  const t = today(now);
  const perDay = new Map<string, number>();
  let left = 0;
  for (const x of all) {
    if (x.status === 'done' && x.completedBy === me && x.completedAt) {
      const d = today(new Date(x.completedAt));
      perDay.set(d, (perDay.get(d) ?? 0) + 1);
    } else if (x.status === 'open' && isMine(x, me) && x.dueDate && x.dueDate <= t) left++;
  }
  let streak = 0;
  let d = perDay.get(t) ? t : addDays(t, -1);
  while (perDay.get(d)) {
    streak++;
    d = addDays(d, -1);
  }
  const week = Array.from({ length: 7 }, (_, i) => perDay.get(addDays(t, i - 6)) ?? 0);
  return { doneToday: perDay.get(t) ?? 0, left, streak, week };
}

const subtaskCache = new WeakMap<Record<string, Task>, Map<string, Task[]>>();

/** parentId → its subtasks (oldest first), cached per tasks map. */
export function subtaskIndex(tasks: Record<string, Task>): Map<string, Task[]> {
  let m = subtaskCache.get(tasks);
  if (m) return m;
  m = new Map();
  for (const t of Object.values(tasks)) if (t.parentId) m.set(t.parentId, [...(m.get(t.parentId) ?? []), t]);
  for (const list of m.values()) list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  subtaskCache.set(tasks, m);
  return m;
}
