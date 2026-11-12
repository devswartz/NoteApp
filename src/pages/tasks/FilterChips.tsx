// The task filter bar: an "Add filter" button and one chip per condition.
// Chips combine with AND. A chip holds several values (a task matches any of them) and can be flipped
// to "is not" (it matches none of them): "Assignee is Alice, Bob" or "Assignee is not Mike".
import { useState, type ReactNode } from 'react';
import { Check, ChevronLeft, Minus, Plus, Search, X } from 'lucide-react';
import { useStore } from '../../store.ts';
import { Avatar, Dropdown, MenuItem, MenuLabel, MenuSeparator } from '../../components/ui.tsx';
import { groupAssignees, tickState, toggleGroup } from '../../lib/assigneeGroups.ts';
import { DEFAULT_FILTERS, NO_PICK, PICK_KEYS, activeFilterKeys, orderedTeams, teamLabel, type Filters, type PickKey } from '../../lib/taskViews.ts';
import { LabelDot } from '../../components/Labels.tsx';
import { sectionPathLabel, sectionsInOrder } from '../../../shared/sections.ts';

export type Kind = 'teamId' | 'assignee' | 'assignedBy' | 'tagsAny' | 'tagsNone' | 'due' | 'priority' | 'source' | 'notebookId' | 'sectionId';
export const KINDS: { key: Kind; label: string }[] = [
  { key: 'teamId', label: 'Team' },
  { key: 'assignee', label: 'Assignee' },
  { key: 'assignedBy', label: 'Assigned by' },
  { key: 'tagsAny', label: 'Tags' },
  { key: 'tagsNone', label: 'Without tags' },
  { key: 'due', label: 'Due' },
  { key: 'priority', label: 'Priority' },
  { key: 'source', label: 'Source' },
  { key: 'notebookId', label: 'Notebook' },
  { key: 'sectionId', label: 'Section' },
];

interface Option {
  value: string;
  /** The full name (a subteam is "Team › Subteam"): in chips, and in search results where the nesting isn't shown. */
  label: string;
  icon?: ReactNode;
  /** The short name shown in the nested list. */
  name?: string;
  /** Nesting level in the list (0 = top). */
  depth?: number;
  /** The value of the option this one sits under: ticking the parent covers it too. */
  parent?: string;
  /** A caption that groups the options after it (a notebook); not selectable. */
  heading?: boolean;
  /** Muted text on the right (a team's member count; for assignees, open tasks). */
  hint?: string;
  /** A team heading in the Assignee menu: ticking it ticks these people (it stores their ids, never the team). */
  group?: string[];
  /** Muted text after the name in search results (a person's team or teams). */
  sub?: string;
}

function useOptions(kind: Kind): Option[] {
  const members = useStore((s) => s.members);
  const me = useStore((s) => s.user!.id);
  const teams = useStore((s) => s.teams);
  const tags = useStore((s) => s.tags);
  const tree = useStore((s) => s.tree);
  const tasks = useStore((s) => s.tasks);
  const people = members.filter((m) => m.id !== me).map((m) => ({ value: m.id, label: m.name, icon: <Avatar user={m} size={16} /> }));
  switch (kind) {
    case 'teamId':
      return [
        ...orderedTeams(teams).map((t): Option => {
          const sub = !!t.parentId && teams.some((p) => p.id === t.parentId);
          return {
            value: t.id,
            label: teamLabel(t, teams),
            name: t.name,
            depth: sub ? 1 : 0,
            parent: sub ? t.parentId! : undefined,
            hint: t.memberIds.length ? String(t.memberIds.length) : undefined,
            icon: <LabelDot color={t.color} />,
          };
        }),
        { value: 'none', label: 'No team' },
      ];
    case 'assignee': {
      // Pinned Me / Someone else / Unassigned, then everyone under their teams (subteams nested), those in no team last.
      const { groups, teamsOf } = groupAssignees(teams, members.map((m) => ({ id: m.id, name: m.name })));
      const open = new Map<string, number>();
      const openTasks = Object.values(tasks).filter((t) => t.status === 'open' && t.assigneeId);
      for (const t of openTasks) open.set(t.assigneeId!, (open.get(t.assigneeId!) ?? 0) + 1);
      const byId = new Map(members.map((m) => [m.id, m]));
      const count = (n: number | undefined) => (n ? String(n) : undefined);
      const out: Option[] = [{ value: 'me', label: 'Me' }, { value: 'others', label: 'Someone else' }, { value: 'unassigned', label: 'Unassigned' }];
      for (const g of groups) {
        const headed = !!g.name;
        if (headed) {
          const ids = new Set(g.all);
          out.push({ value: g.key, label: g.name, group: g.all, depth: g.depth, icon: <LabelDot color={teams.find((t) => t.id === g.teamId)?.color ?? 'var(--text-muted)'} />, hint: count(openTasks.filter((t) => ids.has(t.assigneeId!)).length) });
        }
        for (const id of g.direct) {
          const m = byId.get(id)!;
          out.push({ value: id, label: m.name, depth: headed ? g.depth + 1 : 0, icon: <Avatar user={m} size={16} />, sub: (teamsOf.get(id) ?? []).join(', ') || undefined, hint: count(open.get(id)) });
        }
      }
      return out;
    }
    case 'assignedBy':
      return [{ value: 'me', label: 'Me' }, ...people];
    case 'tagsAny':
    case 'tagsNone':
      return tags.map((t) => ({ value: t.id, label: t.name, icon: <LabelDot color={t.color} /> }));
    case 'due':
      return [
        { value: 'overdue', label: 'Overdue' },
        { value: 'today', label: 'Today or earlier' },
        { value: 'week', label: 'Next 7 days' },
        { value: 'none', label: 'No date' },
      ];
    case 'priority':
      return [
        { value: '1', label: 'Priority 1' },
        { value: '2', label: 'Priority 2' },
        { value: '3', label: 'Priority 3' },
        { value: '4', label: 'No priority' },
      ];
    case 'source':
      return [
        { value: 'notes', label: 'On pages' },
        { value: 'standalone', label: 'Standalone' },
      ];
    case 'notebookId':
      return tree.notebooks.map((n) => ({ value: n.id, label: n.name }));
    case 'sectionId':
      // Each notebook is a caption over its sections, nested the way they are in the tree.
      return [...tree.notebooks]
        .sort((a, b) => a.position - b.position)
        .flatMap((nb): Option[] => {
          const rows = sectionsInOrder(tree, nb.id);
          if (!rows.length) return [];
          return [
            { value: `notebook:${nb.id}`, label: nb.name, heading: true },
            ...rows.map(({ section, level }): Option => ({
              value: section.id,
              label: sectionPathLabel(tree, section.id, nb.name),
              name: section.name,
              depth: level - 1,
              parent: section.parentId && rows.some((r) => r.section.id === section.parentId) ? section.parentId : undefined,
            })),
          ];
        });
  }
}

const isPick = (k: Kind): k is Kind & PickKey => (PICK_KEYS as string[]).includes(k);
/** Everything but "Due" takes several values. */
const isMulti = (k: Kind) => k !== 'due';

/** The values a kind is filtering by, and whether it's "is not". */
function valuesOf(kind: Kind, filters: Filters): { values: string[]; not: boolean } {
  if (isPick(kind)) return filters[kind];
  if (kind === 'tagsAny' || kind === 'tagsNone') return { values: filters[kind], not: false };
  return { values: filters.due === 'any' ? [] : [filters.due], not: false };
}

/** The filters with one kind's values (and is / is not) replaced. */
function withValues(kind: Kind, filters: Filters, values: string[], not: boolean): Filters {
  if (isPick(kind)) return { ...filters, [kind]: values.length ? { values, not } : NO_PICK };
  if (kind === 'tagsAny' || kind === 'tagsNone') return { ...filters, [kind]: values };
  return { ...filters, due: (values[0] ?? 'any') as Filters['due'] };
}

/** The options for one filter kind: tick several, or flip the whole condition to "is not". */
export function KindMenu({ kind, filters, onChange }: { kind: Kind; filters: Filters; onChange: (f: Filters) => void }) {
  const options = useOptions(kind);
  const teams = useStore((s) => s.teams);
  const current = valuesOf(kind, filters);
  // "Is not" with nothing ticked yet isn't stored in the filters, so the menu remembers it meanwhile.
  const [pendingNot, setPendingNot] = useState(current.not);
  const [query, setQuery] = useState('');
  const not = current.values.length ? current.not : pendingNot;
  const write = (values: string[], n = not) => onChange(withValues(kind, filters, values, n));

  if (!options.length)
    return <div className="menu-pad muted small">{kind === 'teamId' ? 'No teams yet. Owners and admins add them in Settings → Teams.' : isMulti(kind) ? 'Nothing to pick yet.' : 'Nothing to pick.'}</div>;

  // Due: one choice, and picking it closes the menu.
  if (!isMulti(kind))
    return (
      <>
        {options.map((o) => (
          <MenuItem key={o.value} checked={current.values[0] === o.value} onSelect={() => write([o.value])}>
            {o.label}
          </MenuItem>
        ))}
      </>
    );

  const q = query.trim().toLowerCase();
  // Searching flattens the list (matches show their full name); otherwise the hierarchy shows.
  // (A person in two teams is in the list twice; a search lists them once, with their teams in muted text.)
  const seen = new Set<string>();
  const shown = q
    ? options.filter((o) => {
        if (o.heading || o.group || !`${o.label} ${o.sub ?? ''}`.toLowerCase().includes(q) || seen.has(o.value)) return false;
        seen.add(o.value);
        return true;
      })
    : options;
  const pickable = [...new Map(shown.filter((o) => !o.heading && !o.group).map((o) => [o.value, o])).values()];
  const parentOf = new Map(options.filter((o) => o.parent).map((o) => [o.value, o.parent!]));
  /** Covered by a ticked parent (a subteam with "Include subteams" on, a subsection), without being ticked itself. */
  const coveredByParent = (v: string) => {
    if (kind === 'teamId' && !filters.includeSubteams) return false;
    for (let p = parentOf.get(v), guard = 0; p && guard < 5; p = parentOf.get(p), guard++) if (current.values.includes(p)) return true;
    return false;
  };
  const toggle = (v: string) => write(current.values.includes(v) ? current.values.filter((x) => x !== v) : [...current.values, v]);
  const hasSubteams = kind === 'teamId' && teams.some((t) => t.parentId && current.values.includes(t.parentId));
  const canNegate = isPick(kind);
  return (
    <div className="fp">
      {canNegate && (
        <div className="fp-mode" role="group" aria-label="Match">
          <button
            type="button"
            aria-pressed={!not}
            onClick={(e) => {
              e.stopPropagation();
              setPendingNot(false);
              write(current.values, false);
            }}
          >
            Is
          </button>
          <button
            type="button"
            aria-pressed={not}
            className="is-not"
            onClick={(e) => {
              e.stopPropagation();
              setPendingNot(true);
              write(current.values, true);
            }}
          >
            Is not
          </button>
        </div>
      )}
      {new Set(options.filter((o) => !o.heading && !o.group).map((o) => o.value)).size > 7 && (
        <label className="fp-search">
          <Search size={13} />
          <input
            type="search"
            placeholder="Search…"
            aria-label="Search options"
            value={query}
            autoFocus={typeof window !== 'undefined' && !window.matchMedia('(pointer: coarse)').matches}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      )}
      <div className="fp-bulk">
        <span className="muted small">{current.values.length ? `${current.values.length} ${not ? 'left out' : 'selected'}` : 'None selected'}</span>
        <span>
          <button type="button" className="fp-link" disabled={!pickable.length || pickable.every((o) => current.values.includes(o.value))} onClick={(e) => { e.stopPropagation(); write([...new Set([...current.values, ...pickable.map((o) => o.value)])]); }}>
            Select all
          </button>
          <button type="button" className="fp-link" disabled={!current.values.length} onClick={(e) => { e.stopPropagation(); write([]); }}>
            Clear
          </button>
        </span>
      </div>
      <div className="fp-list">
        {shown.map((o, i) => {
          if (o.heading) return <div key={o.value} className="fp-head">{o.label}</div>;
          // A team heading in the Assignee menu: all, some or none of its people ticked.
          const tick = o.group ? tickState(o.group, current.values) : null;
          const checked = tick ? tick === 'all' : current.values.includes(o.value);
          const partial = tick === 'some';
          const covered = !checked && !partial && !q && coveredByParent(o.value);
          const depth = q ? 0 : (o.depth ?? 0);
          return (
            <button
              key={`${i}-${o.value}`}
              type="button"
              role="menuitemcheckbox"
              aria-checked={checked}
              className={`menu-item fp-opt ${depth ? 'fp-nested' : ''} ${o.group ? 'fp-team' : ''}`}
              data-team-heading={o.group ? o.label : undefined}
              style={depth ? ({ '--d': depth } as React.CSSProperties) : undefined}
              title={covered ? 'Included with the one above' : undefined}
              onClick={(e) => {
                e.stopPropagation();
                if (o.group) write(toggleGroup(o.group, current.values));
                else toggle(o.value);
              }}
            >
              <span className={`fp-box ${checked ? 'is-on' : ''} ${partial ? 'is-covered' : ''} ${covered ? 'is-covered' : ''} ${not ? 'is-not' : ''}`}>
                {partial ? <Minus size={11} strokeWidth={3} /> : (checked || covered) && (not ? <X size={11} strokeWidth={3} /> : <Check size={11} strokeWidth={3} />)}
              </span>
              {o.icon && <span className="menu-icon">{o.icon}</span>}
              <span className="menu-label">{q ? o.label : (o.name ?? o.label)}{q && o.sub && <span className="muted small"> · {o.sub}</span>}</span>
              {o.hint && !q && <span className="menu-hint" title={kind === 'assignee' ? `${o.hint} open task${o.hint === '1' ? '' : 's'}` : `${o.hint} ${o.hint === '1' ? 'person' : 'people'}`}>{o.hint}</span>}
            </button>
          );
        })}
        {!pickable.length && <div className="menu-pad muted small">No matches.</div>}
      </div>
      {hasSubteams && (
        <>
          <MenuSeparator />
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={filters.includeSubteams}
            className="menu-item fp-opt"
            onClick={(e) => {
              e.stopPropagation();
              onChange({ ...filters, includeSubteams: !filters.includeSubteams });
            }}
          >
            <span className={`fp-box ${filters.includeSubteams ? 'is-on' : ''}`}>{filters.includeSubteams && <Check size={11} strokeWidth={3} />}</span>
            <span className="menu-label">Include subteams</span>
          </button>
        </>
      )}
    </div>
  );
}

/** "Alice, Bob" · "Alice, Bob +2" · "Sam"; a team filter without its subteams says "only". */
export function useValueLabel(kind: Kind, filters: Filters): string {
  const options = useOptions(kind);
  const { values } = valuesOf(kind, filters);
  const name = (x: string) => options.find((o) => o.value === x)?.label ?? 'Unknown';
  const text = values.length > 2 ? `${name(values[0])}, ${name(values[1])} +${values.length - 2}` : values.map(name).join(', ');
  return kind === 'teamId' && filters.includeSubteams === false && !values.every((v) => v === 'none') ? `${text} only` : text;
}

/** The word between a chip's name and its values. */
const joinerOf = (kind: Kind, filters: Filters) => (kind === 'tagsAny' ? 'is any of' : kind === 'tagsNone' ? '' : valuesOf(kind, filters).not ? 'is not' : 'is');

function FilterChip({ kind, filters, onChange }: { kind: Kind; filters: Filters; onChange: (f: Filters) => void }) {
  const label = KINDS.find((k) => k.key === kind)!.label;
  const value = useValueLabel(kind, filters);
  const joiner = joinerOf(kind, filters);
  const not = valuesOf(kind, filters).not;
  return (
    <span className={`filter-chip ${not ? 'is-not' : ''}`} data-filter={kind}>
      <Dropdown buttonClass="filter-chip-btn" title={`${label} filter`} trigger={<><span className="filter-chip-key">{label}</span>{joiner && <span className={not ? 'filter-chip-not' : 'muted'}> {joiner} </span>}<span className="filter-chip-val truncate">{value}</span></>}>
        <div className="menu filter-menu">
          <KindMenu kind={kind} filters={filters} onChange={onChange} />
        </div>
      </Dropdown>
      <button type="button" className="filter-chip-x" aria-label={`Remove ${label} filter`} onClick={() => onChange(withoutFilter(filters, kind))}>
        <X size={12} />
      </button>
    </span>
  );
}

/** Add filter: pick a kind, then values, in one popover. */
function AddFilter({ filters, onChange, active }: { filters: Filters; onChange: (f: Filters) => void; active: Kind[] }) {
  if (KINDS.every((k) => active.includes(k.key))) return null;
  return (
    <Dropdown buttonClass="btn btn-secondary btn-sm add-filter" trigger={<><Plus size={14} /> Add filter</>}>
      {(close) => <AddFilterMenu filters={filters} onChange={onChange} active={active} close={close} />}
    </Dropdown>
  );
}

export function AddFilterMenu({ filters, onChange, active, close, kinds = KINDS }: { filters: Filters; onChange: (f: Filters) => void; active: Kind[]; close: () => void; kinds?: typeof KINDS }) {
  const [kind, setKind] = useState<Kind | null>(null);
  const available = kinds.filter((k) => !active.includes(k.key) || k.key === kind);
  return (
    <div className="menu filter-menu">
      {kind ? (
        <>
          <button type="button" className="menu-item menu-back" onClick={() => setKind(null)}>
            <span className="menu-icon"><ChevronLeft size={15} /></span>
            <span className="menu-label">{KINDS.find((k) => k.key === kind)!.label}</span>
          </button>
          <MenuSeparator />
          <KindMenu
            kind={kind}
            filters={filters}
            onChange={(f) => {
              onChange(f);
              if (!isMulti(kind)) {
                setKind(null);
                close();
              }
            }}
          />
        </>
      ) : (
        <>
          <MenuLabel>Filter by</MenuLabel>
          {available.map((k) => (
            <MenuItem key={k.key} keepOpen onSelect={() => setKind(k.key)}>
              {k.label}
            </MenuItem>
          ))}
        </>
      )}
    </div>
  );
}

export function FilterChips({ filters, onChange }: { filters: Filters; onChange: (f: Filters) => void }) {
  const active = activeFilterKeys(filters).filter((k): k is Kind => KINDS.some((x) => x.key === k));
  return (
    <div className="filter-bar" aria-label="Filters">
      {active.map((k) => (
        <FilterChip key={k} kind={k} filters={filters} onChange={onChange} />
      ))}
      <AddFilter filters={filters} onChange={onChange} active={active} />
      {active.length > 1 && (
        <button type="button" className="btn-ghost btn-sm" onClick={() => onChange({ ...DEFAULT_FILTERS, q: filters.q, status: filters.status })}>
          Clear all
        </button>
      )}
    </div>
  );
}

/** The filters without one kind (the team filter's "include subteams" resets with it). */
export const withoutFilter = (filters: Filters, kind: Kind): Filters => ({
  ...filters,
  [kind]: DEFAULT_FILTERS[kind],
  ...(kind === 'teamId' ? { includeSubteams: true } : {}),
});

/** All the filter conditions cleared (the search text and status stay). */
export const clearedFilters = (filters: Filters): Filters => ({ ...DEFAULT_FILTERS, q: filters.q, status: filters.status });

/** The active filter kinds, in the bar's order. */
export const activeKinds = (filters: Filters): Kind[] => activeFilterKeys(filters).filter((k): k is Kind => KINDS.some((x) => x.key === k));

/** How many values a kind is filtering by (the ribbon's count badge). */
export const valueCount = (kind: Kind, filters: Filters): number => valuesOf(kind, filters).values.length;

function SummaryPart({ kind, filters }: { kind: Kind; filters: Filters }) {
  const value = useValueLabel(kind, filters);
  const joiner = joinerOf(kind, filters) === 'is not' ? ' is not ' : ': ';
  return (
    <span className="filter-summary-part" data-filter={kind}>
      {KINDS.find((k) => k.key === kind)!.label}
      {joiner}
      {value}
    </span>
  );
}

/** Desktop: the active filters in words next to the result count (the ribbon sets them). */
export function FilterSummary({ filters, viewName }: { filters: Filters; viewName?: string }) {
  const active = activeKinds(filters);
  if (!active.length && !viewName && filters.status === 'open') return null;
  return (
    <span className="filter-summary" aria-label="Active filters">
      {viewName && <span className="filter-summary-part">View: {viewName}</span>}
      {filters.status !== 'open' && <span className="filter-summary-part">{filters.status === 'done' ? 'Completed only' : 'Including completed'}</span>}
      {active.map((k) => (
        <SummaryPart key={k} kind={k} filters={filters} />
      ))}
    </span>
  );
}
