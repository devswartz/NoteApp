// Landing page for the emailed confirmation link: /verify-email?token=…
// Works signed in or out: the server endpoint is public. Signed in, the app loads afterwards; signed out, sign in.
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { post } from '../api.ts';
import { recheckEmailVerified, useStore } from '../store.ts';
import { APP_NAME } from '../../shared/config.ts';

export function VerifyEmail() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const user = useStore((s) => s.user);
  const navigate = useNavigate();
  const [state, setState] = useState<'working' | 'done' | 'failed'>('working');
  const [error, setError] = useState('');
  const started = useRef(false);
  const target = user ? '/' : '/login';

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const signedIn = !!useStore.getState().user;
    (async () => {
      try {
        if (!token) throw new Error('This link is incomplete. Open the link from your email again.');
        await post('/auth/verify-email', { token });
        // Signed in here: pick up the confirmed account (and any workspace invites applied with it).
        if (signedIn) await recheckEmailVerified().catch(() => false);
        setState('done');
      } catch (e) {
        // A link that was already used still means "confirmed" if this account is.
        if (signedIn && (await recheckEmailVerified().catch(() => false))) return setState('done');
        setError(e instanceof Error ? e.message : 'Something went wrong');
        setState('failed');
      }
    })();
  }, [token]);

  useEffect(() => {
    if (state !== 'done') return;
    const t = setTimeout(() => navigate(target, { replace: true }), 2500);
    return () => clearTimeout(t);
  }, [state, target, navigate]);

  return (
    <div className="auth">
      <div className="auth-card">
        <div className="auth-logo">
          <img className="auth-icon" src="/icon.svg" alt="" width={34} height={34} />
          <span>{APP_NAME}</span>
        </div>
        {state === 'working' && <p className="muted">Confirming your email…</p>}
        {state === 'done' && (
          <>
            <h1>Email confirmed</h1>
            <p className="muted">{user ? `You're all set. Opening ${APP_NAME}…` : 'You can sign in now.'}</p>
            <Link className="btn btn-primary btn-lg" to={target} replace>
              {user ? `Continue to ${APP_NAME}` : 'Sign in'}
            </Link>
          </>
        )}
        {state === 'failed' && (
          <>
            <h1>Link not valid</h1>
            <div className="form-error" role="alert">
              {error}
            </div>
            <Link className="btn btn-primary btn-lg" to={target} replace>
              {user ? 'Request a new link' : 'Sign in'}
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
