// People grouped by team, for the Assignee filter and the assignee picker (pure: tests/assigneeGroups.test.ts).
// Teams nest like the Team menu (orderedTeams: a team, then its subteams); a person in two teams is listed under both;
// people in no team go under "No team" at the bottom. `all` is what ticking a heading in the filter covers: the team's
// own people plus its subteams'. A workspace with no teams gets no headings at all.
import { orderedTeams, teamLabel } from './taskViews.ts';
import type { Team } from '../../shared/types.ts';

export interface PersonRef {
  id: string;
  name: string;
}

export interface AssigneeGroup {
  /** `team:<id>`, or `none` for people in no team. */
  key: string;
  teamId: string | null;
  name: string;
  /** 0 for a team, 1 for a subteam. */
  depth: number;
  /** Listed under this heading. */
  direct: string[];
  /** direct plus the subteams' people (what ticking the heading ticks). */
  all: string[];
}

export interface Grouped {
  groups: AssigneeGroup[];
  /** Each person's team names ("Design", "Eng › Platform"), for the muted text in search results. */
  teamsOf: Map<string, string[]>;
}

const byName = (a: PersonRef, b: PersonRef) => a.name.localeCompare(b.name);

export function groupAssignees(teams: Team[], people: PersonRef[]): Grouped {
  const known = new Map(people.map((p) => [p.id, p]));
  const sorted = (ids: Iterable<string>) => [...new Set(ids)].map((id) => known.get(id)).filter((p): p is PersonRef => !!p).sort(byName).map((p) => p.id);
  const teamsOf = new Map<string, string[]>();
  const groups: AssigneeGroup[] = [];
  const inAnyTeam = new Set<string>();
  for (const t of orderedTeams(teams)) {
    const sub = !!t.parentId && teams.some((p) => p.id === t.parentId);
    const children = teams.filter((s) => s.parentId === t.id);
    const direct = sorted(t.memberIds);
    const all = sorted([...t.memberIds, ...children.flatMap((c) => c.memberIds)]);
    direct.forEach((id) => {
      inAnyTeam.add(id);
      teamsOf.set(id, [...(teamsOf.get(id) ?? []), teamLabel(t, teams)]);
    });
    all.forEach((id) => inAnyTeam.add(id));
    if (!all.length) continue; // an empty team has nobody to pick
    groups.push({ key: `team:${t.id}`, teamId: t.id, name: t.name, depth: sub ? 1 : 0, direct, all });
  }
  const loose = sorted(people.filter((p) => !inAnyTeam.has(p.id)).map((p) => p.id));
  if (loose.length) groups.push({ key: 'none', teamId: null, name: 'No team', depth: 0, direct: loose, all: loose });
  // With no team headings at all, a "No team" heading over everyone says nothing.
  return { groups: groups.length === 1 && groups[0]!.teamId === null ? [{ ...groups[0]!, name: '' }] : groups, teamsOf };
}

/** How a team heading in the filter reads: all of its people ticked, some, or none. */
export function tickState(all: readonly string[], ticked: readonly string[]): 'all' | 'some' | 'none' {
  const n = all.filter((id) => ticked.includes(id)).length;
  return n === 0 ? 'none' : n === all.length ? 'all' : 'some';
}

/** The ticked values after clicking a heading: everything under it ticked, or (when it already was) all of it cleared. */
export function toggleGroup(all: readonly string[], ticked: readonly string[]): string[] {
  return tickState(all, ticked) === 'all' ? ticked.filter((id) => !all.includes(id)) : [...new Set([...ticked, ...all])];
}
