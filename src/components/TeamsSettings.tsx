// Settings → Teams and Settings → Tags. Owners and admins manage; everyone else sees them read-only.
import { CornerDownRight, MoreHorizontal, Plus, Tag as TagIcon, Users } from 'lucide-react';
import { api, del, patch, post } from '../api.ts';
import { errorToast, loadTags, loadTeams, toast, useStore } from '../store.ts';
import type { Team } from '../../shared/types.ts';
import { orderedTeams } from '../lib/taskViews.ts';
import { Avatar, Button, Dropdown, EmptyState, MenuItem, MenuLabel, MenuSeparator } from './ui.tsx';
import { confirmDialog, promptDialog } from './shell/dialogs.tsx';
import { LabelDot, TagChip } from './Labels.tsx';
import '../styles/tasks.css';

const COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#14b8a6', '#64748b'];

function useIsAdmin() {
  return useStore((s) => ['owner', 'admin'].includes(s.workspaces.find((w) => w.id === s.wsId)?.role ?? ''));
}

function ColorMenu({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="color-menu" role="group" aria-label="Colour">
      {COLORS.map((c) => (
        <button key={c} type="button" className={`color-swatch ${c === value ? 'is-active' : ''}`} style={{ background: c }} aria-label={`Colour ${c}`} aria-pressed={c === value} onClick={() => onChange(c)} />
      ))}
    </div>
  );
}

const run = (p: Promise<unknown>, after: () => Promise<unknown>) => p.then(after).catch(errorToast);

export function TeamsPanel() {
  const teams = useStore((s) => s.teams);
  const wsId = useStore((s) => s.wsId!);
  const isAdmin = useIsAdmin();
  const add = async (parent?: Team) => {
    const name = (await promptDialog({ title: parent ? `New subteam of ${parent.name}` : 'New team', label: 'Name', confirmLabel: 'Create' }))?.trim();
    if (name) await run(post(`/workspaces/${wsId}/teams`, { name, parentId: parent?.id ?? null }), loadTeams);
  };
  const ordered = orderedTeams(teams);
  return (
    <section className="card">
      <div className="setting-row">
        <p className="muted small grow card-desc">
          A task can belong to a team, whoever it’s assigned to. Filter by team in All Tasks, group by team in Team, and type <code>+team</code> in quick add.
          {!isAdmin && ' Owners and admins manage teams.'}
        </p>
        {isAdmin && (
          <Button icon={<Plus size={15} />} onClick={() => void add()}>
            New team
          </Button>
        )}
      </div>
      {ordered.length === 0 ? (
        <EmptyState icon={<Users size={22} />} title="No teams yet" description={isAdmin ? 'Create teams like “Elders” or “Staff”, with subteams one level deep.' : 'Owners and admins can create teams.'} />
      ) : (
        <div className="member-list team-list">
          {ordered.map((t) => (
            <TeamRow key={t.id} team={t} isAdmin={isAdmin} onAddSub={() => void add(t)} />
          ))}
        </div>
      )}
    </section>
  );
}

function TeamRow({ team, isAdmin, onAddSub }: { team: Team; isAdmin: boolean; onAddSub: () => void }) {
  const members = useStore((s) => s.members);
  const inTeam = members.filter((m) => team.memberIds.includes(m.id));
  const setMembers = (ids: string[]) => void run(api(`/teams/${team.id}/members`, { method: 'PUT', json: { userIds: ids } }), loadTeams);
  return (
    <div className={`member-row team-row ${team.parentId ? 'is-sub' : ''}`} data-team={team.name}>
      {team.parentId && <CornerDownRight size={14} className="muted" />}
      <LabelDot color={team.color} />
      <div className="grow team-row-main">
        <div className="setting-title truncate">{team.name}</div>
        <div className="muted small">
          {inTeam.length ? `${inTeam.length} member${inTeam.length === 1 ? '' : 's'}` : 'No members'}
        </div>
      </div>
      <div className="avatar-stack" aria-hidden>
        {inTeam.slice(0, 5).map((m) => (
          <Avatar key={m.id} user={m} size={22} />
        ))}
      </div>
      {isAdmin && (
        <>
          <Dropdown buttonClass="btn btn-secondary btn-sm" placement="bottom-end" trigger={<>Members</>} title={`Members of ${team.name}`}>
            <div className="menu">
              <MenuLabel>Members of {team.name}</MenuLabel>
              {members.map((m) => {
                const on = team.memberIds.includes(m.id);
                return (
                  <MenuItem key={m.id} keepOpen icon={<Avatar user={m} size={18} />} checked={on} onSelect={() => setMembers(on ? team.memberIds.filter((x) => x !== m.id) : [...team.memberIds, m.id])}>
                    {m.name}
                  </MenuItem>
                );
              })}
            </div>
          </Dropdown>
          <Dropdown buttonClass="btn-ghost icon-btn" placement="bottom-end" title={`Options for ${team.name}`} trigger={<MoreHorizontal size={16} />}>
            {(close) => (
              <div className="menu">
                <MenuItem
                  onSelect={async () => {
                    const name = (await promptDialog({ title: 'Rename team', label: 'Name', initial: team.name, confirmLabel: 'Rename' }))?.trim();
                    if (name && name !== team.name) await run(patch(`/teams/${team.id}`, { name }), loadTeams);
                  }}
                >
                  Rename…
                </MenuItem>
                {!team.parentId && <MenuItem onSelect={onAddSub}>Add subteam…</MenuItem>}
                <MenuLabel>Colour</MenuLabel>
                <ColorMenu value={team.color} onChange={(color) => (close(), void run(patch(`/teams/${team.id}`, { color }), loadTeams))} />
                <MenuSeparator />
                <MenuItem
                  danger
                  onSelect={async () => {
                    const ok = await confirmDialog({
                      title: `Delete ${team.name}?`,
                      message: `Its tasks stay, without a team.${team.parentId ? '' : ' Its subteams are deleted too.'}`,
                      confirmLabel: 'Delete team',
                      danger: true,
                    });
                    if (ok) await run(del(`/teams/${team.id}`), () => loadTeams().then(() => toast('Team deleted')));
                  }}
                >
                  Delete team
                </MenuItem>
              </div>
            )}
          </Dropdown>
        </>
      )}
    </div>
  );
}

export function TagsPanel() {
  const tags = useStore((s) => s.tags);
  const tasks = useStore((s) => s.tasks);
  const isAdmin = useIsAdmin();
  const counts = new Map<string, number>();
  for (const t of Object.values(tasks)) if (t.status === 'open') for (const id of t.tagIds ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
  return (
    <section className="card">
      <p className="muted small card-desc">
        Tags are shared by everyone in the workspace. Anyone who can edit adds them from a task’s Tags field or with <code>#tag</code> in quick add.
        {isAdmin ? ' Here you can rename, recolour or delete them.' : ' Owners and admins can rename or delete them.'}
      </p>
      {tags.length === 0 ? (
        <EmptyState icon={<TagIcon size={22} />} title="No tags yet" description="Add one from any task, e.g. “Waiting”." />
      ) : (
        <div className="member-list">
          {tags.map((t) => (
            <div key={t.id} className="member-row" data-tag={t.name}>
              <TagChip tag={t} />
              <span className="grow muted small">{counts.get(t.id) ? `${counts.get(t.id)} open task${counts.get(t.id) === 1 ? '' : 's'}` : ''}</span>
              {isAdmin && (
                <Dropdown buttonClass="btn-ghost icon-btn" placement="bottom-end" title={`Options for ${t.name}`} trigger={<MoreHorizontal size={16} />}>
                  {(close) => (
                    <div className="menu">
                      <MenuItem
                        onSelect={async () => {
                          const name = (await promptDialog({ title: 'Rename tag', label: 'Name', initial: t.name, confirmLabel: 'Rename' }))?.trim();
                          if (name && name !== t.name) await run(patch(`/tags/${t.id}`, { name }), loadTags);
                        }}
                      >
                        Rename…
                      </MenuItem>
                      <MenuLabel>Colour</MenuLabel>
                      <ColorMenu value={t.color} onChange={(color) => (close(), void run(patch(`/tags/${t.id}`, { color }), loadTags))} />
                      <MenuSeparator />
                      <MenuItem
                        danger
                        onSelect={async () => {
                          const ok = await confirmDialog({ title: `Delete “${t.name}”?`, message: 'It’s removed from every task. The tasks stay.', confirmLabel: 'Delete tag', danger: true });
                          if (ok) await run(del(`/tags/${t.id}`), loadTags);
                        }}
                      >
                        Delete tag
                      </MenuItem>
                    </div>
                  )}
                </Dropdown>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
