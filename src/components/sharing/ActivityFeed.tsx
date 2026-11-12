// Workspace activity feed screen (/w/:wsId/activity): who changed what,
// newest first, grouped by day, live. Owner: Collaboration & Access.
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { create } from 'zustand';
import { format, isToday, isYesterday } from 'date-fns';
import { Activity } from 'lucide-react';
import { get } from '../../api.ts';
import { errorToast, ui, useStore } from '../../store.ts';
import { Avatar } from '../ui.tsx';
import type { ActivityItem } from '../../../shared/types.ts';
import './inbox.css';

/** Bumped by the live `activity` event (src/store/events.ts). */
const useActivityTick = create<{ tick: number }>(() => ({ tick: 0 }));
export const activityChanged = () => useActivityTick.setState((s) => ({ tick: s.tick + 1 }));

const PAGE = 50;

function dayLabel(iso: string) {
  const d = new Date(iso);
  return isToday(d) ? 'Today' : isYesterday(d) ? 'Yesterday' : format(d, 'EEEE, d MMMM');
}

export function ActivityFeed() {
  const wsId = useStore((s) => s.wsId);
  const members = useStore((s) => s.members);
  const pages = useStore((s) => s.tree.pages);
  const tick = useActivityTick((s) => s.tick);
  const navigate = useNavigate();
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [more, setMore] = useState(false);

  const load = useCallback(
    async (before?: number) => {
      if (!wsId) return;
      try {
        const r = await get<ActivityItem[]>(`/workspaces/${wsId}/activity?limit=${PAGE}${before ? `&before=${before}` : ''}`);
        setItems((prev) => (before ? [...prev, ...r] : r));
        setMore(r.length === PAGE);
        setLoaded(true);
      } catch (e) {
        errorToast(e);
      }
    },
    [wsId],
  );
  // First load, and refresh the newest page on live updates (keeps older pages already loaded).
  useEffect(() => {
    void load();
  }, [load, tick]);

  const open = (i: ActivityItem) => {
    if (i.targetType === 'page' && pages.some((p) => p.id === i.targetId)) navigate(`/w/${wsId}/p/${i.targetId}`);
    else if (i.targetType === 'task') ui.openTask(i.targetId);
  };

  let lastDay = '';
  return (
    <div className="activity-page">
      <h1>
        <Activity size={20} /> Activity
      </h1>
      {loaded && !items.length && <p className="muted">Nothing yet. Changes to pages, tasks and members will show up here.</p>}
      <div className="activity-list">
        {items.map((i) => {
          const day = dayLabel(i.createdAt);
          const header = day !== lastDay ? <h2 className="activity-day">{(lastDay = day)}</h2> : null;
          const actor = members.find((m) => m.id === i.actorId);
          const clickable = (i.targetType === 'page' && pages.some((p) => p.id === i.targetId)) || i.targetType === 'task';
          return (
            <div key={i.id}>
              {header}
              <button className={`activity-row ${clickable ? 'is-link' : ''}`} onClick={() => clickable && open(i)} disabled={!clickable}>
                <Avatar user={actor ?? { name: 'Former member', color: '#999999' }} size={26} />
                <span className="activity-text">
                  <strong>{actor?.name ?? 'Former member'}</strong> {i.summary}
                </span>
                <span className="muted small" title={new Date(i.createdAt).toLocaleString()}>
                  {format(new Date(i.createdAt), 'HH:mm')}
                </span>
              </button>
            </div>
          );
        })}
      </div>
      {more && (
        <button className="btn btn-secondary" onClick={() => void load(items.at(-1)?.id)}>
          Load older
        </button>
      )}
    </div>
  );
}
