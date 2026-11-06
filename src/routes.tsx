// Screens inside a workspace (/w/:wsId/…), registered in one place.
// To add a screen, add one line here; App.tsx renders them inside the app shell.
import type { ReactElement } from 'react';
import { PageView } from './pages/PageView.tsx';
import { TasksView } from './pages/TasksView.tsx';
import { Settings } from './pages/Settings.tsx';
import { NotesHome } from './pages/NotesHome.tsx';
import { ActivityFeed } from './components/sharing/ActivityFeed.tsx';

export interface AppRoute {
  /** Path relative to /w/:wsId. */
  path: string;
  element: ReactElement;
}

export const workspaceRoutes: AppRoute[] = [
  { path: 'p/:pageId', element: <PageView /> }, // Editor & Notes
  { path: 'notes', element: <NotesHome /> }, // Editor & Notes
  { path: 'tasks/:view', element: <TasksView /> }, // Tasks & Dashboard
  { path: 'settings', element: <Settings /> }, // UI shell / Collaboration
  { path: 'activity', element: <ActivityFeed /> }, // Collaboration
];
