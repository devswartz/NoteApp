import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, Trash2, LogOut } from 'lucide-react';
import { del, patch } from '../api.ts';
import { errorToast, loadWorkspaces, signOut, toast, useStore } from '../store.ts';
import { Avatar } from '../components/ui.tsx';
import { AppearanceSettings } from '../components/shell/AppearanceSettings.tsx';
import { platform } from '../platform/index.ts';
import { MembersPanel, ROLE_HELP } from '../components/sharing/MembersPanel.tsx';

export function Settings() {
  const user = useStore((s) => s.user!);
  const ws = useStore((s) => s.workspaces.find((w) => w.id === s.wsId));
  const navigate = useNavigate();
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
        <h2>Appearance</h2>
        <AppearanceSettings />
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

      <MembersPanel />

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
