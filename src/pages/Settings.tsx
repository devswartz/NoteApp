// Settings: a sectioned page (Linear-style). Desktop shows a section nav on the
// left; mobile shows the list of sections, then one section per screen.
// The selected section is in the URL (?s=appearance) so it can be linked to.
//
// Other areas plug panels in here as components:
//   Notifications → Recurrence & Reminders (NotificationSettingsPanel)
//   Members       → Collaboration & Access (MembersPanel)
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Bell, Lock, ChevronLeft, ChevronRight, Info, Keyboard, LogOut, Palette, Trash2, User, Users, Building2 } from 'lucide-react';
import { del, get, patch } from '../api.ts';
import { errorToast, loadWorkspaces, signOut, toast, useStore } from '../store.ts';
import { Avatar, Button, Input, useIsMobile } from '../components/ui.tsx';
import { AppearanceSettings } from '../components/shell/AppearanceSettings.tsx';
import { NotificationSettingsPanel } from '../components/notifications/index.ts';
import { AppLockSettings, hasAppLock } from '../components/shell/AppLockSettings.tsx';
import { ShortcutList } from '../components/Overlays.tsx';
import { MembersPanel, ROLE_HELP } from '../components/sharing/MembersPanel.tsx';
import { platform, detectPlatform } from '../platform/index.ts';
import { APP_NAME, APP_DESCRIPTION } from '../../shared/config.ts';
import { AvatarColorPicker, ChangePasswordForm } from '../components/AccountSettings.tsx';
import { WorkspaceData } from '../components/WorkspaceData.tsx';


interface SectionDef {
  id: string;
  title: string;
  icon: ReactNode;
  group: 'Account' | 'Workspace' | 'App';
  render: () => ReactNode;
  /** Show the section only when this returns true (checked at render, after platform init). */
  when?: () => boolean;
}

const SECTIONS: SectionDef[] = [
  { id: 'profile', title: 'Profile', icon: <User size={16} />, group: 'Account', render: () => <ProfileSection /> },
  { id: 'appearance', title: 'Appearance', icon: <Palette size={16} />, group: 'Account', render: () => <AppearanceSettings /> },
  { id: 'security', title: 'Security', icon: <Lock size={16} />, group: 'Account', render: () => <AppLockSettings />, when: hasAppLock },
  { id: 'notifications', title: 'Notifications', icon: <Bell size={16} />, group: 'Account', render: () => (
      <>
        <DeviceNotifications />
        <NotificationSettingsPanel onError={errorToast} onMessage={toast} />
      </>
    ),
  },
  { id: 'workspace', title: 'General', icon: <Building2 size={16} />, group: 'Workspace', render: () => <WorkspaceSection /> },
  { id: 'members', title: 'Members', icon: <Users size={16} />, group: 'Workspace', render: () => <MembersPanel /> },
  { id: 'shortcuts', title: 'Keyboard shortcuts', icon: <Keyboard size={16} />, group: 'App', render: () => <ShortcutList columns={false} /> },
  { id: 'about', title: 'About', icon: <Info size={16} />, group: 'App', render: () => <AboutSection /> },
];

export function Settings() {
  const sections = SECTIONS.filter((x) => !x.when || x.when());
  const ws = useStore((s) => s.workspaces.find((w) => w.id === s.wsId));
  const [params, setParams] = useSearchParams();
  const isMobile = useIsMobile();
  const requested = sections.find((x) => x.id === params.get('s'));
  const [visible, setVisible] = useState<string>(SECTIONS[0].id);
  const scroller = useRef<HTMLDivElement>(null);

  // Desktop: every section on one scrolling page; the nav jumps to a section and
  // highlights the one in view. ?s=<id> scrolls to it on load.
  useEffect(() => {
    if (isMobile || !requested) return;
    document.getElementById(`settings-${requested.id}`)?.scrollIntoView({ block: 'start' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile, requested?.id, !!ws]);
  useEffect(() => {
    if (isMobile || !scroller.current) return;
    const root = scroller.current;
    const onScroll = () => {
      const line = root.getBoundingClientRect().top + 120;
      const atEnd = root.scrollTop + root.clientHeight >= root.scrollHeight - 4;
      const secs = [...root.querySelectorAll<HTMLElement>('.settings-section')];
      const cur = atEnd ? secs[secs.length - 1] : secs.filter((el) => el.getBoundingClientRect().top <= line).pop() ?? secs[0];
      if (cur) setVisible(cur.id.replace('settings-', ''));
    };
    onScroll();
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => root.removeEventListener('scroll', onScroll);
  }, [isMobile, ws?.id]);

  if (!ws) return null;
  const groups = ['Account', 'Workspace', 'App'] as const;
  const select = (id: string | null) => {
    if (isMobile) setParams(id ? { s: id } : {});
    else if (id) {
      setParams({ s: id }, { replace: true });
      document.getElementById(`settings-${id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  };
  const active = isMobile ? requested?.id : visible;

  const nav = (
    <nav className="settings-nav" aria-label="Settings sections">
      {groups.map((g) => (
        <div key={g} className="settings-nav-group">
          <div className="settings-nav-heading">{g === 'Workspace' ? ws.name : g}</div>
          {sections.filter((x) => x.group === g).map((x) => (
            <button
              key={x.id}
              type="button"
              className={`settings-nav-item ${!isMobile && active === x.id ? 'is-active' : ''}`}
              aria-current={!isMobile && active === x.id ? 'location' : undefined}
              onClick={() => select(x.id)}
            >
              {x.icon}
              <span className="grow">{x.title}</span>
              {isMobile && <ChevronRight size={16} className="muted" />}
            </button>
          ))}
        </div>
      ))}
    </nav>
  );

  if (isMobile) {
    if (!requested)
      return (
        <div className="settings is-list">
          <h1>Settings</h1>
          {nav}
        </div>
      );
    return (
      <div className="settings">
        <div className="settings-content" key={requested.id}>
          <button type="button" className="settings-back" onClick={() => select(null)}>
            <ChevronLeft size={18} /> Settings
          </button>
          <h1>{requested.title}</h1>
          {requested.render()}
        </div>
      </div>
    );
  }

  return (
    <div className="settings" ref={scroller}>
      {nav}
      <div className="settings-content">
        <h1>Settings</h1>
        {sections.map((x) => (
          <section key={x.id} id={`settings-${x.id}`} className="settings-section" aria-labelledby={`settings-h-${x.id}`}>
            <h2 id={`settings-h-${x.id}`} className="settings-section-title">
              {x.title}
            </h2>
            {x.render()}
          </section>
        ))}
      </div>
    </div>
  );
}

function Card({ title, description, children, tone }: { title?: string; description?: ReactNode; children: ReactNode; tone?: 'danger' }) {
  return (
    <section className={`card ${tone === 'danger' ? 'danger-zone' : ''}`}>
      {title && <h3 className="card-title">{title}</h3>}
      {description && <p className="muted small card-desc">{description}</p>}
      {children}
    </section>
  );
}

function ProfileSection() {
  const user = useStore((s) => s.user!);
  const navigate = useNavigate();
  const [name, setName] = useState(user.name);
  const [saving, setSaving] = useState(false);
  useEffect(() => setName(user.name), [user.name]);
  const dirty = name.trim() !== '' && name !== user.name;
  return (
    <>
      <Card>
        <form
          className="profile-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (!dirty) return;
            setSaving(true);
            patch('/me', { name: name.trim() })
              .then((u) => {
                useStore.setState({ user: u as typeof user });
                toast('Profile updated');
              })
              .catch(errorToast)
              .finally(() => setSaving(false));
          }}
        >
          <Avatar user={{ name: name || user.name, color: user.color }} size={56} />
          <div className="grow profile-fields">
            <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
            <Input label="Email" value={user.email} readOnly disabled hint="Your sign-in email can’t be changed yet." />
          </div>
          <Button type="submit" variant="primary" disabled={!dirty} loading={saving}>
            Save
          </Button>
        </form>
      </Card>
      <Card title="Avatar colour">
        <AvatarColorPicker />
      </Card>
      <Card title="Password" description="Changing it signs you out on every other device.">
        <ChangePasswordForm />
      </Card>
      <Card title="Session">
        <Button icon={<LogOut size={15} />} onClick={() => void signOut().then(() => navigate('/login'))}>
          Sign out
        </Button>
      </Card>
    </>
  );
}

/** Permission for system notifications on this device (the platform adapter); delivery settings are Reminders' panel below. */
function DeviceNotifications() {
  const [notif, setNotif] = useState(platform.notifications.permission());
  return (
    <Card title="This device" description="Reminders appear as system notifications when the app is in the background, and in-app otherwise.">
      <div className="setting-row">
        <div className="grow">
          <div className="setting-title">Task reminders</div>
          <div className="muted small">
            {notif === 'granted'
              ? 'Enabled on this device'
              : notif === 'denied'
                ? 'Blocked in your browser settings — reminders show in-app only'
                : notif === 'unsupported'
                  ? 'Not supported here — reminders show in-app only'
                  : 'Allow notifications to get reminders when the app is in the background'}
          </div>
        </div>
        {notif === 'default' && (
          <Button size="sm" onClick={() => void platform.notifications.request().then(setNotif)}>
            Enable notifications
          </Button>
        )}
      </div>
    </Card>
  );
}

function WorkspaceSection() {
  const ws = useStore((s) => s.workspaces.find((w) => w.id === s.wsId))!;
  const navigate = useNavigate();
  const [wsName, setWsName] = useState(ws.name);
  useEffect(() => setWsName(ws.name), [ws.name]);
  const isAdmin = ws.role === 'owner' || ws.role === 'admin';
  return (
    <>
      <Card>
        <form
          className="row gap-10 align-end"
          onSubmit={(e) => {
            e.preventDefault();
            patch(`/workspaces/${ws.id}`, { name: wsName.trim() })
              .then(() => loadWorkspaces())
              .then(() => toast('Workspace renamed'))
              .catch(errorToast);
          }}
        >
          <span className="ws-logo lg">{ws.name[0]?.toUpperCase()}</span>
          <div className="grow">
            <Input label="Workspace name" value={wsName} disabled={!isAdmin} onChange={(e) => setWsName(e.target.value)} />
          </div>
          {isAdmin && (
            <Button type="submit" disabled={!wsName.trim() || wsName === ws.name}>
              Rename
            </Button>
          )}
        </form>
        <p className="muted small">
          Your role: <strong>{ws.role}</strong> — {ROLE_HELP[ws.role]}
        </p>
      </Card>
      <Card
        title="Backup and import"
        description={
          isAdmin
            ? 'Export downloads a .zip with every page as Markdown, all tasks, attachments and a full backup. Import creates a new workspace from such a .zip.'
            : 'Import creates a new workspace from an exported .zip.'
        }
      >
        <WorkspaceData wsId={ws.id} canExport={isAdmin} />
      </Card>
      {ws.role === 'owner' && (
        <Card title="Danger zone" tone="danger" description="Deleting a workspace removes every notebook, page and task in it for everyone. This can’t be undone.">
          <Button
            variant="danger"
            icon={<Trash2 size={15} />}
            onClick={() => {
              if (prompt(`Type the workspace name (“${ws.name}”) to delete it and everything in it.`) !== ws.name) return;
              del(`/workspaces/${ws.id}`)
                .then(() => loadWorkspaces())
                .then(() => navigate('/'))
                .catch(errorToast);
            }}
          >
            Delete workspace
          </Button>
        </Card>
      )}
    </>
  );
}

function AboutSection() {
  const [server, setServer] = useState<string | null>(null);
  useEffect(() => {
    get<{ ok: boolean; version?: string }>('/health')
      .then((r) => setServer(r.version ?? 'dev'))
      .catch(() => setServer('unreachable'));
  }, []);
  return (
    <Card>
      <div className="about-head">
        <span className="ws-logo lg">{APP_NAME[0]}</span>
        <div>
          <div className="setting-title">{APP_NAME}</div>
          <div className="muted small">{APP_DESCRIPTION}</div>
        </div>
      </div>
      <dl className="about-list">
        <dt>App version</dt>
        <dd>{import.meta.env.VITE_APP_VERSION || 'dev'}</dd>
        <dt>Server version</dt>
        <dd>{server ?? '…'}</dd>
        <dt>Platform</dt>
        <dd>{detectPlatform()}</dd>
      </dl>
    </Card>
  );
}
