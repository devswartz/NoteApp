import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, Mail, Trash2, UserMinus, LogOut } from 'lucide-react';
import { del, patch, post } from '../api.ts';
import { errorToast, loadWorkspaces, signOut, toast, useStore } from '../store.ts';
import { Avatar } from '../components/ui.tsx';
import type { Role } from '../../shared/types.ts';
import { platform } from '../platform/index.ts';

const ROLE_HELP: Record<Role, string> = {
  owner: 'Full control, including deleting the workspace',
  admin: 'Manage members and all content',
  member: 'Create and edit notes and tasks',
  viewer: 'Read-only access to shared notebooks',
};

export function Settings() {
  const user = useStore((s) => s.user!);
  const ws = useStore((s) => s.workspaces.find((w) => w.id === s.wsId));
  const members = useStore((s) => s.members);
  const invites = useStore((s) => s.invites);
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [name, setName] = useState(user.name);
  const [wsName, setWsName] = useState(ws?.name ?? '');
  const [notif, setNotif] = useState(platform.notifications.permission());
  if (!ws) return null;
  const isAdmin = ws.role === 'owner' || ws.role === 'admin';

  return (
    <div className="settings">
      <h1>Settings</h1>

      <section className="card">
        <h2>Your profile</h2>
        <div className="row gap-10">
          <Avatar user={{ name, color: user.color }} size={40} />
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 280 }} />
          <button
            className="btn btn-secondary"
            disabled={!name.trim() || name === user.name}
            onClick={() =>
              patch('/me', { name })
                .then((u) => {
                  useStore.setState({ user: u as typeof user });
                  toast('Profile updated');
                })
                .catch(errorToast)
            }
          >
            Save
          </button>
        </div>
        <p className="muted small">{user.email}</p>
        <div className="row gap-10" style={{ marginTop: 12 }}>
          <Bell size={16} />
          <span>Task reminders</span>
          {notif === 'granted' ? (
            <span className="chip">Enabled on this device</span>
          ) : notif === 'denied' || notif === 'unsupported' ? (
            <span className="muted small">
              {notif === 'denied' ? 'Blocked in browser settings' : 'Not supported here'} — reminders show in-app only
            </span>
          ) : (
            <button className="btn btn-secondary btn-sm" onClick={() => void platform.notifications.request().then(setNotif)}>
              Enable notifications
            </button>
          )}
        </div>
        <button className="btn btn-secondary" style={{ marginTop: 16 }} onClick={() => void signOut().then(() => navigate('/login'))}>
          <LogOut size={15} /> Sign out
        </button>
      </section>

      <section className="card">
        <h2>Workspace</h2>
        <div className="row gap-10">
          <input className="input" value={wsName} disabled={!isAdmin} onChange={(e) => setWsName(e.target.value)} style={{ maxWidth: 320 }} />
          {isAdmin && (
            <button
              className="btn btn-secondary"
              disabled={!wsName.trim() || wsName === ws.name}
              onClick={() => patch(`/workspaces/${ws.id}`, { name: wsName }).then(() => loadWorkspaces()).then(() => toast('Workspace renamed')).catch(errorToast)}
            >
              Rename
            </button>
          )}
        </div>
        <p className="muted small">Your role: {ws.role} — {ROLE_HELP[ws.role]}</p>
      </section>

      <section className="card">
        <h2>Members</h2>
        {isAdmin && (
          <form
            className="row gap-8 wrap invite-form"
            onSubmit={(e) => {
              e.preventDefault();
              post<{ status: string }>(`/workspaces/${ws.id}/members`, { email, role })
                .then((r) => {
                  toast(r.status === 'added' ? `${email} added to the workspace` : `Invitation saved — ${email} will join when they sign up`);
                  setEmail('');
                })
                .catch(errorToast);
            }}
          >
            <Mail size={16} className="muted" />
            <input className="input" type="email" required placeholder="teammate@company.com" value={email} onChange={(e) => setEmail(e.target.value)} style={{ flex: '1 1 220px' }} />
            <select className="input" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              <option value="member">Member</option>
              <option value="viewer">Viewer</option>
              <option value="admin">Admin</option>
              {ws.role === 'owner' && <option value="owner">Owner</option>}
            </select>
            <button className="btn btn-primary">Invite</button>
          </form>
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
              {isAdmin && m.id !== user.id ? (
                <select
                  className="input input-sm"
                  value={m.role}
                  onChange={(e) => patch(`/workspaces/${ws.id}/members/${m.id}`, { role: e.target.value }).catch(errorToast)}
                >
                  <option value="owner" disabled={ws.role !== 'owner'}>Owner</option>
                  <option value="admin">Admin</option>
                  <option value="member">Member</option>
                  <option value="viewer">Viewer</option>
                </select>
              ) : (
                <span className="chip">{m.role}</span>
              )}
              {((isAdmin && m.id !== user.id) || m.id === user.id) && (
                <button
                  className="btn-ghost icon-btn"
                  title={m.id === user.id ? 'Leave workspace' : 'Remove member'}
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
          {invites.map((i) => (
            <div key={i.email} className="member-row">
              <Avatar user={null} size={32} />
              <div className="grow">
                <div>{i.email}</div>
                <div className="muted small">Invited · joins when they create an account</div>
              </div>
              <span className="chip">{i.role}</span>
              <button className="btn-ghost icon-btn" title="Revoke invite" onClick={() => del(`/workspaces/${ws.id}/invites/${encodeURIComponent(i.email)}`).catch(errorToast)}>
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>
      </section>

      {ws.role === 'owner' && (
        <section className="card danger-zone">
          <h2>Danger zone</h2>
          <button
            className="btn btn-danger"
            onClick={() => {
              if (prompt(`Type the workspace name (“${ws.name}”) to delete it and everything in it.`) !== ws.name) return;
              del(`/workspaces/${ws.id}`)
                .then(() => loadWorkspaces())
                .then(() => navigate('/'))
                .catch(errorToast);
            }}
          >
            <Trash2 size={15} /> Delete workspace
          </button>
        </section>
      )}
    </div>
  );
}
