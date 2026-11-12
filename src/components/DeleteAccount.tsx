// Settings → Profile → "Delete account": what is deleted and what stays, which workspaces are affected,
// then password re-entry in a confirm dialog. Server: DELETE /auth/account (server/accounts.ts).
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Trash2 } from 'lucide-react';
import { api, get } from '../api.ts';
import { errorMessage, signOut, toast } from '../store.ts';
import { Button, Dialog, Input } from './ui.tsx';
import { APP_NAME } from '../../shared/config.ts';
import type { AccountDeletionPreview } from '../../shared/types.ts';

const names = (list: { name: string }[]) => list.map((w) => `“${w.name}”`).join(', ');

export function DeleteAccountCard() {
  const navigate = useNavigate();
  const [preview, setPreview] = useState<AccountDeletionPreview | null>(null);
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    get<AccountDeletionPreview>('/auth/account/deletion-preview').then(setPreview).catch(() => setPreview(null));
  }, []);

  const close = () => {
    if (busy) return;
    setOpen(false);
    setPassword('');
    setError(null);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/auth/account', { method: 'DELETE', json: { password } });
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
      return;
    }
    await signOut();
    navigate('/login');
    toast(`Your ${APP_NAME} account was deleted.`);
  };

  return (
    <section className="card danger-zone" aria-labelledby="delete-account-title" style={{ marginTop: 24 }}>
      <h3 className="card-title" id="delete-account-title">
        Delete account
      </h3>
      <p className="muted small card-desc">
        Permanently deletes your {APP_NAME} account. This can’t be undone, and we can’t recover it for you.
      </p>
      <div className="small" style={{ display: 'grid', gap: 8, marginBottom: 12 }}>
        <div>
          <strong>Deleted:</strong> your sign-in, your private notebooks with their pages, tasks, comments and files, your private tasks, reminders,
          notifications and devices, and any invitations you sent or received.
        </div>
        <div>
          <strong>Stays:</strong> what you shared with others in workspaces that continue: pages, tasks, comments and files. They show “Deleted user”
          as the author, and tasks assigned to you become unassigned.
        </div>
        {preview && (
          <>
            {preview.deletedWorkspaces.length > 0 && (
              <div data-testid="delete-ws-list">
                <strong>Workspaces deleted for everyone</strong> (you own them and there is no admin to hand them to): {names(preview.deletedWorkspaces)}.
              </div>
            )}
            {preview.transferredWorkspaces.length > 0 && (
              <div data-testid="transfer-ws-list">
                <strong>Handed over:</strong> {preview.transferredWorkspaces.map((w) => `“${w.name}” to ${w.newOwnerName}`).join(', ')}.
              </div>
            )}
            {preview.sharedOwnership.length > 0 && (
              <div>
                <strong>Other owners carry on:</strong> {names(preview.sharedOwnership)}.
              </div>
            )}
            {preview.leftWorkspaces.length > 0 && (
              <div>
                <strong>You leave:</strong> {names(preview.leftWorkspaces)}.
              </div>
            )}
          </>
        )}
      </div>
      <Button variant="danger" icon={<Trash2 size={15} />} onClick={() => setOpen(true)}>
        Delete account…
      </Button>
      <Dialog
        open={open}
        onClose={close}
        title="Delete your account?"
        size="sm"
        description={`This permanently deletes your ${APP_NAME} account and everything listed above. Enter your password to confirm.`}
        footer={
          <>
            <Button onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button variant="danger" form="delete-account-form" type="submit" loading={busy} disabled={!password}>
              Delete my account
            </Button>
          </>
        }
      >
        <form
          id="delete-account-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (password && !busy) void submit();
          }}
        >
          <Input
            label="Password"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            error={error ?? undefined}
            onChange={(e) => setPassword(e.target.value)}
          />
        </form>
      </Dialog>
    </section>
  );
}
