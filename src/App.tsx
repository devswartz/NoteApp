import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { bootstrap, markEmailUnverified, signOut, useStore } from './store.ts';
import { fileUrl, setEmailUnverifiedHandler, setUnauthorizedHandler } from './api.ts';
import { CheckEmail } from './pages/CheckEmail.tsx';
import { VerifyEmail } from './pages/VerifyEmail.tsx';
import { AppShell } from './components/AppShell.tsx';
import { Toasts } from './components/Overlays.tsx';
import { DeepLinks } from './components/DeepLinks.tsx';
import { AppUpdates } from './components/AppUpdates.tsx';
import { Login } from './pages/Login.tsx';
import { LegalPage } from './pages/Legal.tsx';
import { InvitePage, takePendingInvite } from './components/sharing/InvitePage.tsx';
import { ShareDialogHost } from './components/sharing/ShareDialog.tsx';
import { SharedPageRedirect } from './components/sharing/SharedWithMe.tsx';
import { workspaceRoutes } from './routes.tsx';
import { ResetPassword } from './pages/ResetPassword.tsx';
import { RouteBoundary } from './components/ErrorBoundary.tsx';
import { useIsMobile } from './components/ui.tsx';
import { platform } from './platform/index.ts';

export function App() {
  const [ready, setReady] = useState(false);
  const user = useStore((s) => s.user);

  useEffect(() => {
    setUnauthorizedHandler(() => void signOut());
    setEmailUnverifiedHandler(markEmailUnverified); // any API call answered 403 email_unverified
    bootstrap().finally(() => setReady(true));
  }, []);

  if (!ready) return <div className="splash" />;

  // Signed in but the email isn't confirmed: one "check your email" screen, nothing else (the server refuses the rest).
  if (user?.emailVerified === false)
    return (
      <BrowserRouter>
        <Routes>
          <Route path="/verify-email" element={<VerifyEmail />} />
          <Route path="/reset" element={<ResetPassword />} />
          <Route path="/privacy" element={<LegalPage doc="privacy" />} />
          <Route path="/terms" element={<LegalPage doc="terms" />} />
          <Route path="*" element={<CheckEmail />} />
        </Routes>
        <Toasts />
        <AppUpdates />
      </BrowserRouter>
    );

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login />} />
        <Route path="/invite/:token" element={<InvitePage />} />
        <Route path="/privacy" element={<LegalPage doc="privacy" />} />
        <Route path="/terms" element={<LegalPage doc="terms" />} />
        <Route path="/reset" element={<ResetPassword />} />
        <Route path="/verify-email" element={<VerifyEmail />} />
        {user ? (
          <>
            <Route path="/" element={<Home />} />
            <Route path="/shared/:pageId" element={<SharedPageRedirect />} />
            <Route path="/open-file/:name" element={<OpenFile />} />
            <Route path="/w/:wsId" element={<AppShell />}>
              <Route index element={<WorkspaceIndex />} />
              {workspaceRoutes.map((r) => (
                <Route key={r.path} path={r.path} element={<RouteBoundary>{r.element}</RouteBoundary>} />
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
      {user && <ShareDialogHost />}
    </BrowserRouter>
  );
}

function Home() {
  const workspaces = useStore((s) => s.workspaces);
  const [invite] = useState(takePendingInvite); // signed in from an invite link: finish joining
  if (invite) return <Navigate to={invite} replace />;
  const last = platform.kv.get('noteapp.lastWs');
  const ws = workspaces.find((w) => w.id === last) ?? workspaces[0];
  if (!ws) return <div className="empty-page">You don’t belong to any workspace yet.</div>;
  return <Navigate to={`/w/${ws.id}`} replace />;
}

/**
 * An old, unsigned upload link opened in a browser tab (the server sends it here): sign it for
 * whoever is signed in and go there. The server still checks they may see the file.
 */
function OpenFile() {
  const { name = '' } = useParams();
  const ok = /^[0-9a-f]{32}(\.[a-z0-9]{1,10})?$/.test(name);
  useEffect(() => {
    if (ok) location.replace(fileUrl(`/uploads/${name}`));
  }, [ok, name]);
  return ok ? <div className="splash" /> : <Navigate to="/" replace />;
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
