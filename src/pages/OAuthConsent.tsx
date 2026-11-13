// Consent page for AI connectors (/oauth/consent?request=<id>), reached from the server's /oauth/authorize
// (server/oauth/routes.ts). Signed out: remembers the request and goes through the normal sign-in, and Home
// brings you back here. Signed in: names the app (its own, unverified, description), lists what it may do
// in plain words, and Allow / Deny sends the browser back to the app.
import { useEffect, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { ApiError, get, post } from '../api.ts';
import { signOut, useStore } from '../store.ts';
import { platform } from '../platform/index.ts';
import { Button } from '../components/ui.tsx';
import { APP_NAME } from '../../shared/config.ts';
import type { OAuthConsentInfo, OAuthScope } from '../../shared/types.ts';

const PENDING_KEY = 'noteapp.pendingOAuth';
const REQUEST_ID = /^[A-Za-z0-9_-]{16,100}$/;

/** True while a connect request waits for the user to sign in. */
export function hasPendingOAuth(): boolean {
  return !!platform.kv.get(PENDING_KEY);
}

/** Where to go after signing in, if an app was waiting for consent (cleared when read). */
export function takePendingOAuth(): string | null {
  const id = platform.kv.get(PENDING_KEY);
  if (!id) return null;
  platform.kv.remove(PENDING_KEY);
  return REQUEST_ID.test(id) ? `/oauth/consent?request=${encodeURIComponent(id)}` : null;
}

/** Plain-words descriptions of each permission. */
export const SCOPE_TEXT: Record<OAuthScope, { title: string; detail: string }> = {
  'notes:read': {
    title: 'Read your notes',
    detail: 'See the notebooks, sections and pages you can open, in every workspace you belong to.',
  },
  'notes:write': {
    title: 'Create and edit notes',
    detail: 'Add pages and change pages you’re allowed to edit. It can’t delete workspaces or change who has access.',
  },
};

const ERRORS: Record<string, string> = {
  invalid_client: 'This app isn’t registered with ' + APP_NAME + ', or its registration couldn’t be checked.',
  invalid_redirect_uri: 'This app asked to send you to an address it didn’t register, so the request was stopped.',
  invalid_request: 'The app’s request was malformed.',
};

export function OAuthConsent() {
  const [params] = useSearchParams();
  const user = useStore((s) => s.user);
  const requestId = params.get('request') ?? '';
  const error = params.get('error');
  const valid = REQUEST_ID.test(requestId);

  if (!error && valid && !user) {
    platform.kv.set(PENDING_KEY, requestId);
    return <Navigate to="/login" replace />;
  }

  return (
    <div className="auth">
      <div className="auth-card oauth-card">
        <div className="auth-logo">
          <img className="auth-icon" src="/icon.svg" alt="" width={34} height={34} />
          <span>{APP_NAME}</span>
        </div>
        {error || !valid ? (
          <>
            <h1>Can’t connect this app</h1>
            <p className="muted">{ERRORS[error ?? ''] ?? 'This link isn’t a valid connection request.'} Go back to the app and try connecting again.</p>
          </>
        ) : (
          <ConsentForm requestId={requestId} />
        )}
      </div>
    </div>
  );
}

function ConsentForm({ requestId }: { requestId: string }) {
  const user = useStore((s) => s.user!);
  const [info, setInfo] = useState<OAuthConsentInfo | null>(null);
  const [error, setError] = useState('');
  const [write, setWrite] = useState(true);
  const [busy, setBusy] = useState<'allow' | 'deny' | null>(null);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    get<OAuthConsentInfo>(`/oauth/requests/${encodeURIComponent(requestId)}`)
      .then(setInfo)
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load this request'));
  }, [requestId]);

  const decide = async (allow: boolean) => {
    if (!info) return;
    setBusy(allow ? 'allow' : 'deny');
    setError('');
    try {
      const scopes = info.scopes.filter((s) => s !== 'notes:write' || write);
      const r = await post<{ redirect: string }>(`/oauth/requests/${encodeURIComponent(requestId)}`, { allow, scopes });
      setLeaving(true);
      location.assign(r.redirect);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong');
      setBusy(null);
    }
  };

  if (error && !info)
    return (
      <>
        <h1>Can’t connect this app</h1>
        <p className="muted">{error}</p>
      </>
    );
  if (!info) return <p className="muted">Loading…</p>;
  if (leaving)
    return (
      <>
        <h1>Returning to the app</h1>
        <p className="muted">Taking you back to {info.redirectHost}…</p>
      </>
    );

  const canWrite = info.scopes.includes('notes:write');
  return (
    <>
      <h1>Allow “{info.client.name}” to use your {APP_NAME} account?</h1>
      <p className="muted small oauth-claim">
        The name “{info.client.name}” is provided by the app itself; {APP_NAME} hasn’t verified it.
        {info.client.idHost ? ` The app is identified by ${info.client.idHost}.` : ''} After you choose, you’ll go back to <strong>{info.redirectHost}</strong>.
      </p>
      <p className="small">
        Signed in as <strong>{user.email}</strong>.{' '}
        <button type="button" className="link small auth-inline-link" onClick={() => void signOut()}>
          Not you?
        </button>
      </p>
      <div className="oauth-scopes" role="group" aria-label="What this app can do">
        <div className="oauth-scope">
          <div className="setting-title">{SCOPE_TEXT['notes:read'].title}</div>
          <div className="muted small">{SCOPE_TEXT['notes:read'].detail}</div>
        </div>
        {canWrite && (
          <label className="oauth-scope oauth-scope-toggle">
            <input type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} />
            <span>
              <span className="setting-title">{SCOPE_TEXT['notes:write'].title}</span>
              <span className="muted small"> {SCOPE_TEXT['notes:write'].detail} Untick to allow reading only.</span>
            </span>
          </label>
        )}
      </div>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <div className="oauth-actions">
        <Button onClick={() => void decide(false)} loading={busy === 'deny'} disabled={!!busy}>
          Deny
        </Button>
        <Button variant="primary" onClick={() => void decide(true)} loading={busy === 'allow'} disabled={!!busy}>
          Allow
        </Button>
      </div>
      <p className="muted small center">You can disconnect it at any time in Settings → Connected apps.</p>
    </>
  );
}
