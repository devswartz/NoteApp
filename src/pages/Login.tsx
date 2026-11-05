import { useState } from 'react';
import { signIn } from '../store.ts';
import { post } from '../api.ts';
import { APP_NAME } from '../../shared/config.ts';

export function Login() {
  const [mode, setMode] = useState<'login' | 'register' | 'forgot'>('login');
  const [sent, setSent] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div className="auth">
      <div className="auth-card">
        <div className="auth-logo">
          <span className="ws-logo lg">{APP_NAME[0]}</span>
          <span>{APP_NAME}</span>
        </div>
        <h1>{mode === 'login' ? 'Welcome back' : mode === 'register' ? 'Create your account' : 'Reset your password'}</h1>
        <p className="muted">
          {mode === 'forgot'
            ? sent
              ? 'If that email has an account, a reset link is on its way. It works for an hour.'
              : "Enter your email and we'll send you a link to choose a new password."
            : 'Notes and tasks, connected — for you and your team.'}
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            try {
              if (mode === 'forgot') {
                await post('/auth/forgot', { email: form.email });
                setSent(true);
                return;
              }
              await signIn(mode, mode === 'login' ? { email: form.email, password: form.password } : form);
              // The /login route redirects to / once the user is set.
            } catch (err) {
              setError(err instanceof Error ? err.message : 'Something went wrong');
            } finally {
              setBusy(false);
            }
          }}
        >
          {mode === 'register' && (
            <label>
              Name
              <input className="input" autoComplete="name" required value={form.name} onChange={set('name')} autoFocus />
            </label>
          )}
          <label>
            Email
            <input className="input" type="email" autoComplete="email" required value={form.email} onChange={set('email')} autoFocus={mode !== 'register'} />
          </label>
          {mode !== 'forgot' && (
          <label>
            Password
            <input
              className="input"
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              required
              minLength={mode === 'register' ? 8 : undefined}
              maxLength={mode === 'register' ? 72 : undefined}
              value={form.password}
              onChange={set('password')}
            />
          </label>
          )}
          {mode === 'login' && (
            <button type="button" className="link small" style={{ justifySelf: 'start' }} onClick={() => (setMode('forgot'), setSent(false), setError(''))}>
              Forgot password?
            </button>
          )}
          {error && <div className="form-error">{error}</div>}
          <button className="btn btn-primary btn-lg" disabled={busy || (mode === 'forgot' && sent)}>
            {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : mode === 'register' ? 'Create account' : 'Send reset link'}
          </button>
        </form>
        <p className="muted small center">
          {mode === 'login' ? 'New here?' : mode === 'forgot' ? 'Remembered it?' : 'Already have an account?'}{' '}
          <button className="link" onClick={() => (setMode(mode === 'login' ? 'register' : 'login'), setError(''))}>
            {mode === 'login' ? 'Create an account' : 'Sign in'}
          </button>
        </p>
      </div>
    </div>
  );
}
