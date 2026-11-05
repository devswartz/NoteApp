import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { bootstrap, signOut, useStore } from './store.ts';
import { setUnauthorizedHandler } from './api.ts';
import { AppShell } from './components/AppShell.tsx';
import { Toasts } from './components/Overlays.tsx';
import { DeepLinks } from './components/DeepLinks.tsx';
import { AppUpdates } from './components/AppUpdates.tsx';
import { Login } from './pages/Login.tsx';
import { workspaceRoutes } from './routes.tsx';
import { useIsMobile } from './components/ui.tsx';
import { platform } from './platform/index.ts';

export function App() {
  const [ready, setReady] = useState(false);
  const user = useStore((s) => s.user);

  useEffect(() => {
    setUnauthorizedHandler(() => void signOut());
    bootstrap().finally(() => setReady(true));
  }, []);

  if (!ready) return <div className="splash" />;

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login />} />
        {user ? (
          <>
            <Route path="/" element={<Home />} />
            <Route path="/w/:wsId" element={<AppShell />}>
              <Route index element={<WorkspaceIndex />} />
              {workspaceRoutes.map((r) => (
                <Route key={r.path} path={r.path} element={r.element} />
              ))}
              <Route path="*" element={<Navigate to="tasks/today" replace />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </>
        ) : (
          <Route path="*" element={<Navigate to="/login" replace />} />
        )}
      </Routes>
      <Toasts />
      {user && <DeepLinks />}
      <AppUpdates />
    </BrowserRouter>
  );
}

function Home() {
  const workspaces = useStore((s) => s.workspaces);
  const last = platform.kv.get('noteapp.lastWs');
  const ws = workspaces.find((w) => w.id === last) ?? workspaces[0];
  if (!ws) return <div className="empty-page">You don’t belong to any workspace yet.</div>;
  return <Navigate to={`/w/${ws.id}`} replace />;
}

/** Desktop opens the last page you were on; mobile opens Today. */
function WorkspaceIndex() {
  const { wsId } = useParams();
  const isMobile = useIsMobile();
  const pages = useStore((s) => s.tree.pages);
  const loaded = useStore((s) => s.treeLoaded);
  if (isMobile) return <Navigate to="tasks/today" replace />;
  if (!loaded) return null;
  const last = platform.kv.get(`noteapp.lastPage.${wsId}`);
  const page = pages.find((p) => p.id === last) ?? pages[0];
  return <Navigate to={page ? `p/${page.id}` : 'tasks/today'} replace />;
}
