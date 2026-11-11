// The Tasks view's panel: Add task, the built-in task views with counts, and
// saved views (Track 1 serves them from the server behind useSavedViews).
import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Bookmark, CalendarRange, CheckCircle2, Inbox, ListChecks, Plus, Sun, Users } from 'lucide-react';
import { ui, useStore } from '../../store.ts';
import { Badge, Kbd } from '../ui.tsx';
import { isMine } from '../../lib/taskViews.ts';
import { today } from '../../../shared/dates.ts';
import { savedViewPath, useSavedViews } from '../../pages/tasks/savedViews.ts';
import { Group } from './NotesPanel.tsx';
import { treeKeys } from './notesRows.tsx';

export function TasksPanel({ wsId, canEdit }: { wsId: string; canEdit: boolean }) {
  const user = useStore((s) => s.user!);
  const tasks = useStore((s) => s.tasks);
  const views = useSavedViews(wsId);
  const { pathname, search } = useLocation();
  const params = new URLSearchParams(search);
  const viewParam = pathname.endsWith('/tasks/all') ? params.get('view') : null;

  const t = today();
  const in7 = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);
  const mine = Object.values(tasks).filter((x) => x.status === 'open' && isMine(x, user.id));
  const todayCount = mine.filter((x) => x.dueDate && x.dueDate <= t).length;
  const overdue = mine.some((x) => x.dueDate && x.dueDate < t);
  const upcomingCount = mine.filter((x) => x.dueDate && x.dueDate > t && x.dueDate <= in7).length;
  const at = (view: string) => pathname.endsWith(`/tasks/${view}`) && !(view === 'all' && (viewParam || params.get('new')));

  return (
    <>
      <div className="panel-head">
        <h2 className="panel-title">Tasks</h2>
      </div>
      <div className="sb-scroll" onKeyDown={treeKeys}>
        {canEdit && (
          <div className="sb-section">
            <button className="sb-item sb-add" onClick={() => ui.openQuickAdd()}>
              <Plus size={16} /> <span>Add task</span> <Kbd>Q</Kbd>
            </button>
          </div>
        )}
        <div className="sb-section">
          <NavItem to={`/w/${wsId}/tasks/today`} active={at('today')} icon={<Sun size={16} />} label="Today" count={todayCount} danger={overdue} />
          <NavItem to={`/w/${wsId}/tasks/my`} active={at('my')} icon={<Inbox size={16} />} label="My Tasks" count={mine.length} />
          <NavItem to={`/w/${wsId}/tasks/upcoming`} active={at('upcoming')} icon={<CalendarRange size={16} />} label="Upcoming" count={upcomingCount} />
          <NavItem to={`/w/${wsId}/tasks/all`} active={at('all')} icon={<ListChecks size={16} />} label="All Tasks" />
          <NavItem to={`/w/${wsId}/tasks/team`} active={at('team')} icon={<Users size={16} />} label="Team" />
          <NavItem to={`/w/${wsId}/tasks/completed`} active={at('completed')} icon={<CheckCircle2 size={16} />} label="Completed" />
        </div>
        <Group id={`views:${wsId}`} title="Views">
          <div className="sb-section">
            {views.map((v) => (
              <NavItem key={v.id} to={savedViewPath(wsId, v.id)} active={viewParam === v.id} icon={<Bookmark size={15} />} label={v.name} />
            ))}
            <Link to={`/w/${wsId}/tasks/all?new=1`} className="sb-item sb-new-view muted">
              <Plus size={15} /> <span>New view</span>
            </Link>
          </div>
        </Group>
      </div>
    </>
  );
}

export function NavItem({ to, active, icon, label, count, danger }: { to: string; active: boolean; icon: ReactNode; label: string; count?: number; danger?: boolean }) {
  return (
    <Link to={to} className={`sb-item ${active ? 'is-active' : ''}`} aria-current={active ? 'page' : undefined}>
      {icon}
      <span className="truncate">{label}</span>
      {!!count && (
        <Badge tone={danger ? 'danger' : 'neutral'} className="sb-badge">
          {count}
        </Badge>
      )}
    </Link>
  );
}
