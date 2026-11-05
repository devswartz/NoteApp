// Landing page for the emailed reset link: /reset?token=…
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { post } from '../api.ts';
import { APP_NAME } from '../../shared/config.ts';

export function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [pw, setPw] = useState({ next: '', confirm: '' });
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <div className="auth">
      <div className="auth-card">
        <div className="auth-logo">
          <span className="ws-logo lg">{APP_NAME[0]}</span>
          <span>{APP_NAME}</span>
        </div>
        <h1>Choose a new password</h1>
        {done ? (
          <>
            <p className="muted">Your password has been changed and you've been signed out everywhere.</p>
            <Link className="btn btn-primary btn-lg" to="/login">
              Sign in
            </Link>
          </>
        ) : (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (pw.next !== pw.confirm) return setError("Passwords don't match");
              setBusy(true);
              setError('');
              try {
                await post('/auth/reset', { token, password: pw.next });
                setDone(true);
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Something went wrong');
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              New password
              <input className="input" type="password" autoComplete="new-password" required minLength={8} maxLength={72} autoFocus value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
            </label>
            <label>
              Confirm new password
              <input className="input" type="password" autoComplete="new-password" required value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
            </label>
            {error && <div className="form-error">{error}</div>}
            <button className="btn btn-primary btn-lg" disabled={busy || !token}>
              {busy ? 'Please wait…' : 'Set new password'}
            </button>
            {!token && <div className="form-error">This link is incomplete. Open the link from your email again.</div>}
          </form>
        )}
      </div>
    </div>
  );
}
