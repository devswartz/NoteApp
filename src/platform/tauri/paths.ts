// Pure helpers for the desktop menu (kept separate so tests can import them without Vite).

/** Where a navigation command goes when the registry can't run it ("nav.today" → "tasks/today"). */
export function fallbackPath(id: string, pathname: string): string | null {
  const ws = pathname.match(/^\/w\/([^/]+)/)?.[1];
  if (!ws) return null;
  const view = id.match(/^nav\.(today|upcoming|my|team|all|calendar)$/)?.[1];
  if (view) return `/w/${ws}/tasks/${view}`;
  if (id === 'nav.notes') return `/w/${ws}/notes`;
  if (id === 'nav.settings') return `/w/${ws}/settings`;
  return null;
}
