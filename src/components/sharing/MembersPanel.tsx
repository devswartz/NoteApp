// Workspace members: invite by email with a role, change roles, remove people,
// and manage pending invites (copy link, resend, revoke). Owner: Collaboration & Access.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Copy, LogOut, Mail, RotateCw, Trash2, UserMinus } from 'lucide-react';
import { del, patch, post } from '../../api.ts';
import { errorToast, loadWorkspaces, toast, useStore } from '../../store.ts';
import { Avatar } from '../ui.tsx';
import type { Role } from '../../../shared/types.ts';
import './sharing.css';

export const ROLE_HELP: Record<Role, string> = {
  owner: 'Full control, including deleting the workspace',
  admin: 'Manage members and all content',
  member: 'Create and edit notes and tasks',
  viewer: 'Read-only access to shared notebooks',
};

interface InviteResult {
  status: 'added' | 'invited';
  emailed: boolean;
  inviteUrl?: string;
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Link copied');
  } catch {
    prompt('Copy this link', text);
  }
}

export function MembersPanel() {
  const user = useStore((s) => s.user!);
  const ws = useStore((s) => s.workspaces.find((w) => w.id === s.wsId));
  const members = useStore((s) => s.members);
  const invites = useStore((s) => s.invites);
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [busy, setBusy] = useState(false);
  const [lastLink, setLastLink] = useState<{ email: string; url: string } | null>(null);
  if (!ws) return null;
  const isAdmin = ws.role === 'owner' || ws.role === 'admin';
  const nameOf = (id?: string | null) => members.find((m) => m.id === id)?.name;

  const reportInvite = (to: string, r: InviteResult) => {
    if (r.status === 'added') toast(`${to} added to ${ws.name}${r.emailed ? ' — we emailed them' : ''}`);
    else if (r.emailed) toast(`Invite emailed to ${to}`);
    else toast(`Invite created for ${to}. Email isn’t set up, so copy the link and send it yourself.`);
    setLastLink(r.inviteUrl && !r.emailed ? { email: to, url: r.inviteUrl } : null);
  };

  return (
    <section className="card">
      <h2>Members</h2>
      {isAdmin && (
        <form
          className="row gap-8 wrap invite-form"
          onSubmit={(e) => {
            e.preventDefault();
            const to = email.trim().toLowerCase();
            setBusy(true);
            post<InviteResult>(`/workspaces/${ws.id}/members`, { email: to, role })
              .then((r) => {
                reportInvite(to, r);
                setEmail('');
              })
              .catch(errorToast)
              .finally(() => setBusy(false));
          }}
        >
          <Mail size={16} className="muted" />
          <input
            className="input"
            type="email"
            required
            placeholder="teammate@company.com"
            aria-label="Email to invite"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{ flex: '1 1 220px' }}
          />
          <select className="input" aria-label="Role" title={ROLE_HELP[role]} value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="member">Member</option>
            <option value="viewer">Viewer</option>
            <option value="admin">Admin</option>
            {ws.role === 'owner' && <option value="owner">Owner</option>}
          </select>
          <button className="btn btn-primary" disabled={busy}>
            {busy ? 'Inviting…' : 'Invite'}
          </button>
        </form>
      )}
      {isAdmin && <p className="muted small">{ROLE_HELP[role]}.</p>}
      {lastLink && (
        <div className="invite-link">
          <code title={lastLink.url}>{lastLink.url}</code>
          <button className="btn btn-secondary btn-sm" onClick={() => void copy(lastLink.url)}>
            <Copy size={14} /> Copy link
          </button>
        </div>
      )}

      <div className="member-list">
        {members.map((m) => (
          <div key={m.id} className="member-row">
            <Avatar user={m} size={32} />
            <div className="grow">
              <div>
                {m.name} {m.id === user.id && <span className="muted">(you)</span>}
              </div>
              <div className="muted small">{m.email}</div>
            </div>
            {isAdmin && m.id !== user.id && (m.role !== 'owner' || ws.role === 'owner') ? (
              <select
                className="input input-sm"
                aria-label={`Role for ${m.name}`}
                value={m.role}
                onChange={(e) => patch(`/workspaces/${ws.id}/members/${m.id}`, { role: e.target.value }).catch(errorToast)}
              >
                <option value="owner" disabled={ws.role !== 'owner'}>
                  Owner
                </option>
                <option value="admin">Admin</option>
                <option value="member">Member</option>
                <option value="viewer">Viewer</option>
              </select>
            ) : (
              <span className="chip" title={ROLE_HELP[m.role]}>
                {m.role}
              </span>
            )}
            {((isAdmin && m.id !== user.id && (m.role !== 'owner' || ws.role === 'owner')) || m.id === user.id) && (
              <button
                className="btn-ghost icon-btn"
                title={m.id === user.id ? 'Leave workspace' : 'Remove member'}
                aria-label={m.id === user.id ? 'Leave workspace' : `Remove ${m.name}`}
                onClick={() => {
                  if (!confirm(m.id === user.id ? 'Leave this workspace?' : `Remove ${m.name}? Their open tasks will become unassigned.`)) return;
                  del(`/workspaces/${ws.id}/members/${m.id}`)
                    .then(async () => {
                      if (m.id === user.id) {
                        await loadWorkspaces();
                        navigate('/');
                      }
                    })
                    .catch(errorToast);
                }}
              >
                {m.id === user.id ? <LogOut size={16} /> : <UserMinus size={16} />}
              </button>
            )}
          </div>
        ))}

        {invites.map((i) => {
          const expired = !!i.expiresAt && i.expiresAt < new Date().toISOString();
          const by = nameOf(i.invitedBy);
          return (
            <div key={i.email} className={`member-row ${expired ? 'is-expired' : ''}`}>
              <Avatar user={null} size={32} />
              <div className="grow">
                <div>{i.email}</div>
                <div className="muted small">
                  {expired ? 'Invite expired' : 'Invited'}
                  {by ? ` by ${by}` : ''}
                  {i.expiresAt && !expired ? ` · link valid until ${new Date(i.expiresAt).toLocaleDateString()}` : ''}
                </div>
              </div>
              <span className="chip">{i.role}</span>
              <button
                className="btn-ghost icon-btn"
                title="Resend invite (new link)"
                aria-label={`Resend invite to ${i.email}`}
                onClick={() =>
                  post<InviteResult>(`/workspaces/${ws.id}/invites/${encodeURIComponent(i.email)}/resend`)
                    .then((r) => reportInvite(i.email, r))
                    .catch(errorToast)
                }
              >
                <RotateCw size={16} />
              </button>
              <button
                className="btn-ghost icon-btn"
                title="Revoke invite"
                aria-label={`Revoke invite to ${i.email}`}
                onClick={() => del(`/workspaces/${ws.id}/invites/${encodeURIComponent(i.email)}`).catch(errorToast)}
              >
                <Trash2 size={16} />
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
