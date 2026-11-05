// Landing page for an emailed invite link (/invite/:token). Signed out: shows
// what the invite is for and sends you to sign in / sign up, remembering the
// token. Signed in: one click to join. Owner: Collaboration & Access.
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError, get, post } from '../../api.ts';
import { loadWorkspaces, signOut, useStore } from '../../store.ts';
import { platform } from '../../platform/index.ts';
import { APP_NAME } from '../../../shared/config.ts';
import type { InviteInfo } from '../../../shared/types.ts';

const PENDING_KEY = 'noteapp.pendingInvite';

/** The invite token to resume after signing in, if any (cleared when read). */
export function takePendingInvite(): string | null {
  const t = platform.kv.get(PENDING_KEY);
  if (t) platform.kv.remove(PENDING_KEY);
  return t;
}

export function InvitePage() {
  const { token = '' } = useParams();
  const user = useStore((s) => s.user);
  const navigate = useNavigate();
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    get<InviteInfo>(`/invites/${encodeURIComponent(token)}`)
      .then(setInfo)
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load this invite'));
  }, [token]);

  const accept = async () => {
    setBusy(true);
    try {
      const r = await post<{ workspaceId: string }>(`/invites/${encodeURIComponent(token)}/accept`);
      await loadWorkspaces();
      navigate(`/w/${r.workspaceId}`, { replace: true });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not accept the invite');
      setBusy(false);
    }
  };

  const signInFirst = () => {
    platform.kv.set(PENDING_KEY, token);
    navigate('/login', { replace: true });
  };

  return (
    <div className="auth">
      <div className="auth-card">
        <div className="auth-logo">
          <span className="ws-logo lg">{APP_NAME[0]}</span>
          <span>{APP_NAME}</span>
        </div>
        {error ? (
          <>
            <h1>Invite unavailable</h1>
            <p className="muted">{error}</p>
            <button className="btn btn-primary btn-lg invite-cta" onClick={() => navigate('/', { replace: true })}>
              Go to {APP_NAME}
            </button>
          </>
        ) : !info ? (
          <p className="muted">Loading invite…</p>
        ) : info.expired ? (
          <>
            <h1>This invite has expired</h1>
            <p className="muted">Ask {info.invitedByName} to send you a new one.</p>
          </>
        ) : (
          <>
            <h1>Join {info.workspaceName}</h1>
            <p className="muted">
              {info.invitedByName} invited <strong>{info.email}</strong> to join as {info.role === 'admin' ? 'an' : 'a'}{' '}
              <strong>{info.role}</strong>.
            </p>
            {user && user.email.toLowerCase() !== info.email.toLowerCase() ? (
              <>
                <p className="muted small">
                  You’re signed in as {user.email}. This invite is for {info.email}, so sign in (or create an account) with
                  that address to accept it.
                </p>
                <button
                  className="btn btn-primary btn-lg invite-cta"
                  onClick={() => {
                    void signOut().then(signInFirst);
                  }}
                >
                  Switch account
                </button>
              </>
            ) : user ? (
              <button className="btn btn-primary btn-lg invite-cta" disabled={busy} onClick={accept}>
                {busy ? 'Joining…' : `Join ${info.workspaceName}`}
              </button>
            ) : (
              <button className="btn btn-primary btn-lg invite-cta" onClick={signInFirst}>
                Sign in or create an account
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
