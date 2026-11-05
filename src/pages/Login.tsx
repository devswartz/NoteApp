import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { signIn } from '../store.ts';

export function Login() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div className="auth">
      <div className="auth-card">
        <div className="auth-logo">
          <span className="ws-logo lg">N</span>
          <span>Noteworthy</span>
        </div>
        <h1>{mode === 'login' ? 'Welcome back' : 'Create your account'}</h1>
        <p className="muted">Notes and tasks, connected — for you and your team.</p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            try {
              await signIn(mode, mode === 'login' ? { email: form.email, password: form.password } : form);
              navigate('/', { replace: true });
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
            <input className="input" type="email" autoComplete="email" required value={form.email} onChange={set('email')} autoFocus={mode === 'login'} />
          </label>
          <label>
            Password
            <input
              className="input"
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              required
              minLength={mode === 'register' ? 8 : undefined}
              value={form.password}
              onChange={set('password')}
            />
          </label>
          {error && <div className="form-error">{error}</div>}
          <button className="btn btn-primary btn-lg" disabled={busy}>
            {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>
        <p className="muted small center">
          {mode === 'login' ? 'New here?' : 'Already have an account?'}{' '}
          <button className="link" onClick={() => (setMode(mode === 'login' ? 'register' : 'login'), setError(''))}>
            {mode === 'login' ? 'Create an account' : 'Sign in'}
          </button>
        </p>
      </div>
    </div>
  );
}
