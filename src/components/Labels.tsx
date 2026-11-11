// Tags and teams on tasks: chips for rows, and the pickers used by task details and quick add.
import { useState } from 'react';
import { Ban, Plus, Users } from 'lucide-react';
import { post } from '../api.ts';
import { errorToast, loadTags, useStore } from '../store.ts';
import { orderedTeams, teamLabel } from '../lib/taskViews.ts';
import type { Tag, Task } from '../../shared/types.ts';
import { MenuItem, MenuLabel, MenuSeparator } from './ui.tsx';

export function LabelDot({ color }: { color: string }) {
  return <span className="label-dot" style={{ background: color }} aria-hidden />;
}

/** A tag chip, tinted with the tag's colour. */
export function TagChip({ tag }: { tag: Tag }) {
  return (
    <span className="chip tag-chip" style={{ ['--tag' as string]: tag.color }} title={`Tag: ${tag.name}`}>
      {tag.name}
    </span>
  );
}

/** Team badge and tag chips for a task row (unknown ids, e.g. just deleted, are skipped). */
export function TaskLabels({ task }: { task: Task }) {
  const team = useStore((s) => (task.teamId ? s.teams.find((t) => t.id === task.teamId) : undefined));
  const teams = useStore((s) => s.teams);
  const tags = useStore((s) => s.tags);
  const own = (task.tagIds ?? []).map((id) => tags.find((t) => t.id === id)).filter((t): t is Tag => !!t);
  if (!team && !own.length) return null;
  return (
    <>
      {team && (
        <span className="chip team-badge" style={{ ['--tag' as string]: team.color }} title={`Team: ${teamLabel(team, teams)}`}>
          <Users size={11} /> <span className="truncate">{teamLabel(team, teams)}</span>
        </span>
      )}
      {own.length > 0 && (
        <span className="task-tags">
          {own.map((t) => (
            <TagChip key={t.id} tag={t} />
          ))}
        </span>
      )}
    </>
  );
}

/** Create a tag (or get the existing one with that name). Anyone who can edit may. */
export async function ensureTag(name: string): Promise<Tag | null> {
  const { wsId, tags } = useStore.getState();
  const clean = name.replace(/^#+/, '').trim().slice(0, 40);
  if (!wsId || !clean) return null;
  const existing = tags.find((t) => t.name.toLowerCase() === clean.toLowerCase());
  if (existing) return existing;
  try {
    const tag = await post<Tag>(`/workspaces/${wsId}/tags`, { name: clean });
    useStore.setState((s) => ({ tags: s.tags.some((t) => t.id === tag.id) ? s.tags : [...s.tags, tag].sort((a, b) => a.name.localeCompare(b.name)) }));
    void loadTags();
    return tag;
  } catch (e) {
    errorToast(e);
    return null;
  }
}

/** Multi-select tag picker with "Create tag" from the search box. */
export function TagMenu({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const tags = useStore((s) => s.tags);
  const [q, setQ] = useState('');
  const query = q.replace(/^#+/, '').trim();
  const shown = tags.filter((t) => !query || t.name.toLowerCase().includes(query.toLowerCase()));
  const exact = tags.some((t) => t.name.toLowerCase() === query.toLowerCase());
  const create = async () => {
    const tag = await ensureTag(query);
    if (tag && !value.includes(tag.id)) onChange([...value, tag.id]);
    setQ('');
  };
  return (
    <div className="menu tag-menu">
      <div className="menu-pad">
        <input
          autoFocus
          className="input input-sm"
          placeholder="Find or create a tag…"
          aria-label="Find or create a tag"
          value={q}
          maxLength={40}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && query) {
              e.preventDefault();
              const hit = shown.find((t) => t.name.toLowerCase() === query.toLowerCase()) ?? (shown.length === 1 ? shown[0] : undefined);
              if (hit) {
                onChange(value.includes(hit.id) ? value.filter((x) => x !== hit.id) : [...value, hit.id]);
                setQ('');
              } else void create();
            }
          }}
        />
      </div>
      {shown.map((t) => (
        <MenuItem key={t.id} keepOpen icon={<LabelDot color={t.color} />} checked={value.includes(t.id)} onSelect={() => onChange(value.includes(t.id) ? value.filter((x) => x !== t.id) : [...value, t.id])}>
          {t.name}
        </MenuItem>
      ))}
      {query && !exact && (
        <MenuItem keepOpen icon={<Plus size={15} />} onSelect={() => void create()}>
          Create “{query}”
        </MenuItem>
      )}
      {!shown.length && !query && <div className="menu-pad muted small">No tags yet. Type a name to create one.</div>}
    </div>
  );
}

/** Single-select team picker: teams with their subteams indented, then "No team". */
export function TeamMenu({ value, onChange }: { value: string | null; onChange: (id: string | null) => void }) {
  const teams = useStore((s) => s.teams);
  return (
    <div className="menu">
      {teams.length ? (
        <>
          <MenuLabel>Team</MenuLabel>
          {orderedTeams(teams).map((t) => (
            <MenuItem key={t.id} icon={<LabelDot color={t.color} />} checked={value === t.id} onSelect={() => onChange(t.id)}>
              <span className={t.parentId ? 'menu-indent' : undefined}>{t.name}</span>
            </MenuItem>
          ))}
          <MenuSeparator />
        </>
      ) : (
        <div className="menu-pad muted small">No teams yet. Owners and admins add them in Settings → Teams.</div>
      )}
      {value && (
        <MenuItem icon={<Ban size={15} />} onSelect={() => onChange(null)}>
          No team
        </MenuItem>
      )}
    </div>
  );
}
