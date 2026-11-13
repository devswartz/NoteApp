// Settings → Connected apps: AI assistants and other apps the user allowed through the consent page
// (src/pages/OAuthConsent.tsx). Revoke ends every token the app holds. Server: server/oauth/routes.ts.
import { useEffect, useState } from 'react';
import { Plug } from 'lucide-react';
import { del, get } from '../api.ts';
import { errorToast, toast } from '../store.ts';
import { Button } from './ui.tsx';
import { confirmDialog } from './shell/dialogs.tsx';
import { SCOPE_TEXT } from '../pages/OAuthConsent.tsx';
import type { ConnectedApp } from '../../shared/types.ts';

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

export function ConnectedApps() {
  const [apps, setApps] = useState<ConnectedApp[] | null>(null);
  const load = () => get<ConnectedApp[]>('/me/connected-apps').then(setApps).catch(errorToast);
  useEffect(() => {
    void load();
  }, []);

  const revoke = async (app: ConnectedApp) => {
    const ok = await confirmDialog({
      title: `Disconnect “${app.name}”?`,
      message: 'It loses access to your notes straight away. To use it again you’ll have to connect it again.',
      confirmLabel: 'Revoke',
      danger: true,
    });
    if (!ok) return;
    try {
      await del(`/me/connected-apps/${encodeURIComponent(app.clientId)}`);
      toast(`${app.name} disconnected`);
      await load();
    } catch (e) {
      errorToast(e);
    }
  };

  if (!apps) return null;
  if (!apps.length)
    return (
      <section className="card">
        <p className="muted small" style={{ margin: 0 }}>
          No apps are connected. When you connect an AI assistant such as ChatGPT or Claude to your account, it appears here.
        </p>
      </section>
    );
  return (
    <section className="card" aria-label="Connected apps">
      <ul className="connected-apps">
        {apps.map((a) => (
          <li key={a.clientId} className="setting-row connected-app">
            <Plug size={18} className="muted" aria-hidden />
            <div className="grow">
              <div className="setting-title">{a.name}</div>
              <div className="muted small">{a.scopes.includes('notes:write') ? `${SCOPE_TEXT['notes:read'].title}, ${SCOPE_TEXT['notes:write'].title.toLowerCase()}` : `${SCOPE_TEXT['notes:read'].title} only`}</div>
              <div className="muted small">
                Connected {day(a.connectedAt)} · {a.lastUsedAt ? `Last used ${day(a.lastUsedAt)}` : 'Not used yet'}
              </div>
            </div>
            <Button size="sm" variant="danger" onClick={() => void revoke(a)} aria-label={`Revoke ${a.name}`}>
              Revoke
            </Button>
          </li>
        ))}
      </ul>
      <p className="muted small" style={{ marginBottom: 0 }}>
        App names are provided by the apps themselves. Revoke anything you don’t recognise.
      </p>
    </section>
  );
}
