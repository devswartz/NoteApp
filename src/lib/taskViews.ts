// Pure functions that derive dashboard views from the task map.
import { addDays, today } from '../../shared/dates.ts';
import type { Task, Tree } from '../../shared/types.ts';
import { describeDue, longDate } from './format.ts';

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
export type GroupKey = 'none' | 'due' | 'assignee' | 'note' | 'priority';

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
  ctx: { members: { id: string; name: string }[]; tree: Tree },
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
      case 'note': {
        const page = ctx.tree.pages.find((p) => p.id === t.pageId);
        add(page ? `p${page.title}${page.id}` : '~', page ? page.title || 'Untitled' : 'Not in a note', t);
        break;
      }
    }
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, g]) => g);
}

export interface Filters {
  q: string;
  assignee: 'any' | 'me' | 'unassigned' | string;
  priority: 'any' | '1' | '2' | '3' | '4';
  due: 'any' | 'overdue' | 'today' | 'week' | 'none';
  source: 'any' | 'notes' | 'standalone';
  notebookId: 'any' | string;
}

export const DEFAULT_FILTERS: Filters = { q: '', assignee: 'any', priority: 'any', due: 'any', source: 'any', notebookId: 'any' };

export function applyFilters(list: Task[], f: Filters, me: string, tree: Tree): Task[] {
  const t = today();
  const q = f.q.trim().toLowerCase();
  const sectionNotebook = new Map(tree.sections.map((s) => [s.id, s.notebookId]));
  const pageNotebook = new Map(tree.pages.map((p) => [p.id, sectionNotebook.get(p.sectionId)]));
  return list.filter((x) => {
    if (q && !x.title.toLowerCase().includes(q) && !x.description.toLowerCase().includes(q)) return false;
    if (f.assignee === 'me' && !isMine(x, me)) return false;
    if (f.assignee === 'unassigned' && x.assigneeId) return false;
    if (!['any', 'me', 'unassigned'].includes(f.assignee) && x.assigneeId !== f.assignee) return false;
    if (f.priority !== 'any' && x.priority !== Number(f.priority)) return false;
    if (f.due === 'overdue' && !(x.dueDate && x.dueDate < t)) return false;
    if (f.due === 'today' && !(x.dueDate && x.dueDate <= t)) return false;
    if (f.due === 'week' && !(x.dueDate && x.dueDate <= addDays(t, 7))) return false;
    if (f.due === 'none' && x.dueDate) return false;
    if (f.source === 'notes' && !x.pageId) return false;
    if (f.source === 'standalone' && x.pageId) return false;
    if (f.notebookId !== 'any' && (!x.pageId || pageNotebook.get(x.pageId) !== f.notebookId)) return false;
    return true;
  });
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
