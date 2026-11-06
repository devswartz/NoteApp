// Shown instead of the app to a signed-in user whose email isn't confirmed yet (the server refuses everything
// else with 403 `email_unverified`). Resend has a cooldown; "I've verified" re-checks with the server.
import { useEffect, useState } from 'react';
import { ApiError, post } from '../api.ts';
import { recheckEmailVerified, signOut, useStore } from '../store.ts';
import { APP_NAME } from '../../shared/config.ts';
import { Button } from '../components/ui.tsx';

const COOLDOWN_S = 60;

export function CheckEmail() {
  const user = useStore((s) => s.user)!;
  const [cooldown, setCooldown] = useState(0);
  const [sending, setSending] = useState(false);
  const [checking, setChecking] = useState(false);
  const [info, setInfo] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const resend = async () => {
    setSending(true);
    setError('');
    setInfo('');
    try {
      const r = await post<{ alreadyVerified: boolean }>('/auth/resend-verification');
      if (r.alreadyVerified) {
        await recheckEmailVerified(); // confirmed meanwhile: the app takes over
        return;
      }
      setInfo(`We sent a new link to ${user.email}. Older links no longer work.`);
      setCooldown(COOLDOWN_S);
    } catch (e) {
      if (e instanceof ApiError && e.status === 429) setCooldown(COOLDOWN_S);
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setSending(false);
    }
  };

  const check = async () => {
    setChecking(true);
    setError('');
    setInfo('');
    try {
      if (!(await recheckEmailVerified())) setInfo('Not confirmed yet. Open the link in the email we sent, then try again.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="auth">
      <div className="auth-card">
        <div className="auth-logo">
          <img className="auth-icon" src="/icon.svg" alt="" width={34} height={34} />
          <span>{APP_NAME}</span>
        </div>
        <h1>Check your email</h1>
        <p className="muted">
          We sent a confirmation link to <strong>{user.email}</strong>. Open it to start using {APP_NAME}. The link works once, for 24 hours.
        </p>
        {info && (
          <div className="muted small" role="status">
            {info}
          </div>
        )}
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <Button variant="primary" size="lg" loading={checking} onClick={() => void check()}>
          I've verified, continue
        </Button>
        <Button size="lg" loading={sending} disabled={cooldown > 0} onClick={() => void resend()}>
          {cooldown > 0 ? `Resend email (${cooldown}s)` : 'Resend email'}
        </Button>
        <p className="muted small center">
          Wrong address?{' '}
          <button className="link" onClick={() => void signOut()}>
            Sign out
          </button>
        </p>
      </div>
    </div>
  );
}
