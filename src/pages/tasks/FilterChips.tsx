// The All Tasks filter bar: an "Add filter" button and one chip per condition.
// Chips combine with AND; a multi-select chip (tags) matches any of its values (OR).
import { useState, type ReactNode } from 'react';
import { ChevronLeft, Plus, X } from 'lucide-react';
import { useStore } from '../../store.ts';
import { Avatar, Dropdown, MenuItem, MenuLabel, MenuSeparator } from '../../components/ui.tsx';
import { DEFAULT_FILTERS, activeFilterKeys, orderedTeams, teamLabel, type Filters } from '../../lib/taskViews.ts';
import { LabelDot } from '../../components/Labels.tsx';

type Kind = 'teamId' | 'assignee' | 'assignedBy' | 'tagsAny' | 'tagsNone' | 'due' | 'priority' | 'source' | 'notebookId' | 'sectionId';
const KINDS: { key: Kind; label: string }[] = [
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
  label: string;
  icon?: ReactNode;
}

function useOptions(kind: Kind): Option[] {
  const members = useStore((s) => s.members);
  const me = useStore((s) => s.user!.id);
  const teams = useStore((s) => s.teams);
  const tags = useStore((s) => s.tags);
  const tree = useStore((s) => s.tree);
  const people = members.filter((m) => m.id !== me).map((m) => ({ value: m.id, label: m.name, icon: <Avatar user={m} size={16} /> }));
  switch (kind) {
    case 'teamId':
      return [
        ...orderedTeams(teams).map((t) => ({ value: t.id, label: teamLabel(t, teams), icon: <LabelDot color={t.color} /> })),
        { value: 'none', label: 'No team' },
      ];
    case 'assignee':
      return [{ value: 'me', label: 'Me' }, { value: 'others', label: 'Someone else' }, { value: 'unassigned', label: 'Unassigned' }, ...people];
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
        { value: 'notes', label: 'In notes' },
        { value: 'standalone', label: 'Standalone' },
      ];
    case 'notebookId':
      return tree.notebooks.map((n) => ({ value: n.id, label: n.name }));
    case 'sectionId': {
      const nb = new Map(tree.notebooks.map((n) => [n.id, n.name]));
      return tree.sections.map((s) => ({ value: s.id, label: `${nb.get(s.notebookId) ?? ''} › ${s.name}` }));
    }
  }
}

const isMulti = (k: Kind) => k === 'tagsAny' || k === 'tagsNone';

/** The options for one filter kind; single-choice kinds close on pick, tag kinds toggle. */
function KindMenu({ kind, filters, onChange }: { kind: Kind; filters: Filters; onChange: (f: Filters) => void }) {
  const options = useOptions(kind);
  const teams = useStore((s) => s.teams);
  const value = filters[kind];
  const hasSubteams = kind === 'teamId' && teams.some((t) => t.parentId === filters.teamId);
  if (!options.length)
    return <div className="menu-pad muted small">{kind === 'teamId' ? 'No teams yet. Owners and admins add them in Settings → Teams.' : isMulti(kind) ? 'No tags yet.' : 'Nothing to pick.'}</div>;
  return (
    <>
      {options.map((o) => {
        const checked = Array.isArray(value) ? value.includes(o.value) : value === o.value;
        return (
          <MenuItem
            key={o.value}
            icon={o.icon}
            checked={checked}
            keepOpen={isMulti(kind)}
            onSelect={() => {
              if (Array.isArray(value)) onChange({ ...filters, [kind]: checked ? value.filter((v) => v !== o.value) : [...value, o.value] });
              else onChange({ ...filters, [kind]: o.value });
            }}
          >
            {o.label}
          </MenuItem>
        );
      })}
      {hasSubteams && (
        <>
          <MenuSeparator />
          <MenuItem keepOpen checked={filters.includeSubteams} onSelect={() => onChange({ ...filters, includeSubteams: !filters.includeSubteams })}>
            Include subteams
          </MenuItem>
        </>
      )}
    </>
  );
}

function useValueLabel(kind: Kind, filters: Filters): string {
  const options = useOptions(kind);
  const v = filters[kind];
  const name = (x: string) => options.find((o) => o.value === x)?.label ?? 'Unknown';
  if (Array.isArray(v)) return v.length > 2 ? `${name(v[0])} +${v.length - 1}` : v.map(name).join(', ');
  const label = name(String(v));
  return kind === 'teamId' && filters.includeSubteams === false && v !== 'none' ? `${label} only` : label;
}

function FilterChip({ kind, filters, onChange }: { kind: Kind; filters: Filters; onChange: (f: Filters) => void }) {
  const label = KINDS.find((k) => k.key === kind)!.label;
  const value = useValueLabel(kind, filters);
  const joiner = kind === 'tagsAny' ? 'is any of' : kind === 'tagsNone' ? '' : 'is';
  return (
    <span className="filter-chip" data-filter={kind}>
      <Dropdown buttonClass="filter-chip-btn" title={`${label} filter`} trigger={<><span className="filter-chip-key">{label}</span>{joiner && <span className="muted"> {joiner} </span>}<span className="filter-chip-val truncate">{value}</span></>}>
        <div className="menu filter-menu">
          <KindMenu kind={kind} filters={filters} onChange={onChange} />
        </div>
      </Dropdown>
      <button
        type="button"
        className="filter-chip-x"
        aria-label={`Remove ${label} filter`}
        onClick={() => onChange({ ...filters, [kind]: DEFAULT_FILTERS[kind], ...(kind === 'teamId' ? { includeSubteams: true } : {}) })}
      >
        <X size={12} />
      </button>
    </span>
  );
}

/** Add filter: pick a kind, then a value, in one popover. */
function AddFilter({ filters, onChange, active }: { filters: Filters; onChange: (f: Filters) => void; active: Kind[] }) {
  if (KINDS.every((k) => active.includes(k.key))) return null;
  return (
    <Dropdown buttonClass="btn btn-secondary btn-sm add-filter" trigger={<><Plus size={14} /> Add filter</>}>
      {(close) => <AddFilterMenu filters={filters} onChange={onChange} active={active} close={close} />}
    </Dropdown>
  );
}

function AddFilterMenu({ filters, onChange, active, close }: { filters: Filters; onChange: (f: Filters) => void; active: Kind[]; close: () => void }) {
  const [kind, setKind] = useState<Kind | null>(null);
  const available = KINDS.filter((k) => !active.includes(k.key) || k.key === kind);
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
