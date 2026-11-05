// Account cards for Settings → Profile: avatar colour and password.
import { useState } from 'react';
import { patch, post, startSession } from '../api.ts';
import { errorToast, toast, useStore } from '../store.ts';
import { Button, Input } from './ui.tsx';
import { COLORS } from '../../shared/config.ts';
import type { AuthSession, User } from '../../shared/types.ts';

export function AvatarColorPicker() {
  const user = useStore((s) => s.user!);
  const pick = (color: string) =>
    patch<User>('/me', { color })
      .then((u) => {
        useStore.setState({ user: u });
        toast('Avatar colour updated');
      })
      .catch(errorToast);
  return (
    <div className="row gap-10" role="radiogroup" aria-label="Avatar colour">
      {COLORS.map((c) => (
        <button
          key={c}
          type="button"
          className="swatch"
          role="radio"
          aria-checked={c === user.color}
          aria-label={`Colour ${c}`}
          style={{ background: c, outline: c === user.color ? '2px solid var(--text, #111)' : undefined, outlineOffset: 2 }}
          onClick={() => c !== user.color && void pick(c)}
        />
      ))}
    </div>
  );
}

export function ChangePasswordForm() {
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const error =
    pw.next && pw.next.length < 8 ? 'At least 8 characters' : pw.confirm && pw.confirm !== pw.next ? "Passwords don't match" : undefined;

  return (
    <form
      style={{ display: 'grid', gap: 10, maxWidth: 340 }}
      onSubmit={async (e) => {
        e.preventDefault();
        if (error) return;
        setBusy(true);
        try {
          // Other devices are signed out; this one gets a fresh session.
          const s = await post<AuthSession>('/me/password', { currentPassword: pw.current, newPassword: pw.next });
          await startSession(s);
          setPw({ current: '', next: '', confirm: '' });
          toast('Password changed. Other devices have been signed out.');
        } catch (err) {
          errorToast(err);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Input label="Current password" type="password" autoComplete="current-password" required value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
      <Input label="New password" type="password" autoComplete="new-password" required minLength={8} maxLength={72} value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
      <Input label="Confirm new password" type="password" autoComplete="new-password" required value={pw.confirm} error={error} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
      <div>
        <Button type="submit" variant="primary" loading={busy} disabled={!!error || !pw.current || !pw.next}>
          Change password
        </Button>
      </div>
    </form>
  );
}
