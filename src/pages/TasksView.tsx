// Task dashboard: one route (/w/:wsId/tasks/:view), one component per view in ./tasks/.
import { useLayoutEffect } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { taskView } from './tasks/taskViewState.ts';
import { VIEWS, type ViewId } from '../lib/taskViews.ts';
import { MyView, TeamView, TodayView, UpcomingView } from './tasks/ListViews.tsx';
import { AllView } from './tasks/AllView.tsx';
import { CompletedView } from './tasks/CompletedView.tsx';
import { CalendarView } from './tasks/CalendarView.tsx';
import '../styles/tasks.css';
import { BulkBar } from './tasks/BulkBar.tsx';
import { useTaskListCommands } from './tasks/commands.tsx';

export function TasksView() {
  const { view, wsId } = useParams() as { view: ViewId; wsId: string };
  useTaskListCommands();
  // Before the views' own effects (a ?view= link applies a saved view): another workspace starts fresh.
  useLayoutEffect(() => taskView.forWorkspace(wsId), [wsId]);
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
      {view !== 'calendar' && <BulkBar />}
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
