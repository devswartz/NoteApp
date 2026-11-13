// Task dashboard: one route (/w/:wsId/tasks/:view), one component per view in ./tasks/.
import { useEffect, useLayoutEffect, useRef } from 'react';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';

import { taskView } from './tasks/taskViewState.ts';
import { VIEWS, type ViewId } from '../lib/taskViews.ts';
import { MyView, TeamView, TodayView, UpcomingView } from './tasks/ListViews.tsx';
import { AllView } from './tasks/AllView.tsx';
import { CalendarView } from './tasks/CalendarView.tsx';
import '../styles/tasks.css';
import { useOpenedView } from './tasks/savedViews.ts';
import { ViewFilterBar } from './tasks/ViewFilterBar.tsx';
import { BulkBar } from './tasks/BulkBar.tsx';
import { useTaskListCommands } from './tasks/commands.tsx';

export function TasksView() {
  const { view: viewParam, wsId } = useParams() as { view: string; wsId: string };
  const view = viewParam as ViewId;
  useTaskListCommands();
  // Before the views' own effects (a ?view= link applies a saved view): another workspace starts fresh.
  useLayoutEffect(() => taskView.forWorkspace(wsId), [wsId]);
  // Status is Open each time a view is opened (a layout effect, so before a saved view's own Status is applied);
  // the old Completed link is the exception: it sets Completed and moves on to All tasks.
  const lastView = useRef<string | null>(null);
  useLayoutEffect(() => {
    const from = lastView.current;
    lastView.current = view;
    if (from !== null && from !== view && from !== 'completed' && viewParam !== 'completed') taskView.setFilters((f) => (f.status === 'open' ? f : { ...f, status: 'open' }));
  }, [view]);
  const opened = useOpenedView();
  // The old Completed view (and its deep links) is All tasks with Status Completed.
  if (viewParam === 'completed') return <CompletedRedirect />;
  if (!VIEWS.some((v) => v.id === view)) return <Navigate to="../today" replace />;
  const saved = view === 'all' ? opened : undefined;
  const label = saved?.name ?? VIEWS.find((v) => v.id === view)!.label;
  return (
    <div className="tasks-page">
      {view === 'calendar' ? (
        <CalendarView />
      ) : (
        <div className="tasks-inner">
          <header className="view-head">
            <h1>{label}</h1>
            {saved ? <p className="muted">Saved view of All tasks.</p> : <ViewSubtitle view={view} />}
          </header>
          {view !== 'all' && <ViewFilterBar />}
          {view === 'today' && <TodayView />}
          {view === 'my' && <MyView />}
          {view === 'upcoming' && <UpcomingView />}
          {view === 'team' && <TeamView />}
          {view === 'all' && <AllView />}
        </div>
      )}
      {view !== 'calendar' && <BulkBar />}
    </div>
  );
}

/** /tasks/completed (old bookmarks, deep links): All tasks with Status Completed. Other query parameters are kept. */
function CompletedRedirect() {
  const { wsId } = useParams() as { wsId: string };
  const { search } = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    taskView.setFilters((f) => ({ ...f, status: 'done' }));
    navigate(`/w/${wsId}/tasks/all${search}`, { replace: true });
  }, [wsId, search, navigate]);
  return null;
}

function ViewSubtitle({ view }: { view: ViewId }) {
  const text: Partial<Record<ViewId, string>> = {
    today: 'Due today and overdue, assigned to you.',
    my: 'Everything assigned to you — from every page.',
    upcoming: 'What’s coming up over the next two weeks.',
    team: 'Who’s working on what across the workspace.',
    all: 'Every task in the workspace. Filter by status, sort and group.',
  };
  return <p className="muted">{text[view]}</p>;
}
