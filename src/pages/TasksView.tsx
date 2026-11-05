// Task dashboard: one route (/w/:wsId/tasks/:view), one component per view in ./tasks/.
import { useEffect } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { useStore } from '../store.ts';
import { VIEWS, type ViewId } from '../lib/taskViews.ts';
import { MyView, TeamView, TodayView, UpcomingView } from './tasks/ListViews.tsx';
import { AllView } from './tasks/AllView.tsx';
import { CompletedView } from './tasks/CompletedView.tsx';
import { CalendarView } from './tasks/CalendarView.tsx';
import '../styles/tasks.css';

export function TasksView() {
  const { view } = useParams() as { view: ViewId };
  useRowNavigation();
  if (!VIEWS.some((v) => v.id === view)) return <Navigate to="../today" replace />;
  const label = VIEWS.find((v) => v.id === view)!.label;
  return (
    <div className="tasks-page">
      {view === 'calendar' ? (
        <CalendarView />
      ) : (
        <div className="tasks-inner">
          <header className="view-head">
            <h1>{label}</h1>
            <ViewSubtitle view={view} />
          </header>
          {view === 'today' && <TodayView />}
          {view === 'my' && <MyView />}
          {view === 'upcoming' && <UpcomingView />}
          {view === 'team' && <TeamView />}
          {view === 'all' && <AllView />}
          {view === 'completed' && <CompletedView />}
        </div>
      )}
    </div>
  );
}

function ViewSubtitle({ view }: { view: ViewId }) {
  const text: Partial<Record<ViewId, string>> = {
    today: 'Due today and overdue, assigned to you.',
    my: 'Everything assigned to you — from every note.',
    upcoming: 'What’s coming up over the next two weeks.',
    team: 'Who’s working on what across the workspace.',
    all: 'Every task in the workspace. Filter, sort and group.',
    completed: 'Recently finished work.',
  };
  return <p className="muted">{text[view]}</p>;
}

/**
 * J/K (or ↓/↑) move focus between task rows. On a focused row: Enter opens it,
 * Space completes, R renames, 1–4 set priority (handled in TaskRow).
 */
function useRowNavigation() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key;
      const dir = k === 'j' || k === 'ArrowDown' ? 1 : k === 'k' || k === 'ArrowUp' ? -1 : 0;
      if (!dir) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest('input, textarea, select, [contenteditable="true"]')) return;
      const s = useStore.getState();
      if (s.paletteOpen || s.quickAdd || s.taskDetailId || s.shortcutsOpen) return;
      const rows = [...document.querySelectorAll<HTMLElement>('.tasks-page .task-row')];
      if (!rows.length) return;
      // Arrow keys only take over once a row has focus, so they still scroll the page otherwise.
      const i = rows.indexOf(document.activeElement as HTMLElement);
      if (i < 0 && k.startsWith('Arrow')) return;
      e.preventDefault();
      const next = rows[i < 0 ? (dir > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, i + dir))];
      next.focus();
      next.scrollIntoView({ block: 'nearest' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
