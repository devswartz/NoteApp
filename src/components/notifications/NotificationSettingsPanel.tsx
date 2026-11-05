// Settings → Notifications: push on this device, email on/off, default
// reminder time, time zone, daily digest. Self-contained:
//
//   <NotificationSettingsPanel />            (a <section className="card"> in Settings)
//
// useAutoTimeZone() stores the browser's time zone the first time a user
// still has the default (UTC), so due times are interpreted locally.
import { useEffect, useState } from 'react';
import { Bell, Mail, Clock, Globe, Send } from 'lucide-react';
import { notificationsApi, type PushInfo } from './api.ts';
import { currentPush, pushSupported, subscribePush, unsubscribePush } from './push.ts';
import { allTimeZones, browserTimeZone } from './timezones.ts';
import { platform } from '../../platform/index.ts';
import type { NotificationSettings } from '../../../shared/types.ts';
import './notifications.css';

const AUTO_TZ_KEY = 'noteapp.tzAutoSet';

/** Call once after sign-in (e.g. in AppShell). */
export function useAutoTimeZone(enabled = true) {
  useEffect(() => {
    if (!enabled || platform.kv.get(AUTO_TZ_KEY)) return;
    const tz = browserTimeZone();
    notificationsApi
      .settings()
      .then((s) => (s.timeZone === 'UTC' && tz !== 'UTC' ? notificationsApi.updateSettings({ timeZone: tz }) : s))
      .then(() => platform.kv.set(AUTO_TZ_KEY, '1'))
      .catch(() => {});
  }, [enabled]);
}

export function NotificationSettingsPanel({ onError, onMessage }: { onError?: (e: unknown) => void; onMessage?: (m: string) => void }) {
  const [s, setS] = useState<NotificationSettings | null>(null);
  const [info, setInfo] = useState<PushInfo | null>(null);
  const [pushOn, setPushOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const fail = (e: unknown) => (onError ? onError(e) : console.error(e));
  const say = (m: string) => onMessage?.(m);

  useEffect(() => {
    notificationsApi.settings().then(setS).catch(fail);
    notificationsApi.pushInfo().then(setInfo).catch(fail);
    currentPush()
      .then((sub) => setPushOn(!!sub))
      .catch(() => setPushOn(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async (p: Partial<NotificationSettings>) => {
    if (!s) return;
    const prev = s;
    setS({ ...s, ...p });
    try {
      setS(await notificationsApi.updateSettings(p));
    } catch (e) {
      setS(prev);
      fail(e);
    }
  };

  const togglePush = async () => {
    if (!info?.publicKey) return;
    setBusy(true);
    try {
      if (pushOn) {
        const endpoint = await unsubscribePush();
        if (endpoint) await notificationsApi.unsubscribe(endpoint);
        setPushOn(false);
        say('Push turned off on this device');
      } else {
        const sub = await subscribePush(info.publicKey);
        if (!sub) {
          say('Notifications are blocked — allow them in your browser settings');
          return;
        }
        await notificationsApi.subscribe(sub);
        setPushOn(true);
        say('Push enabled on this device');
      }
      setInfo(await notificationsApi.pushInfo());
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    try {
      const r = await notificationsApi.test();
      say(r.sent ? `Test sent to ${r.sent} destination${r.sent === 1 ? '' : 's'}` : 'Nothing to send to — enable push or email first');
    } catch (e) {
      fail(e);
    }
  };

  if (!s) return <section className="card ns">Loading notification settings…</section>;
  const browserTz = browserTimeZone();
  const pushHint = !info?.publicKey
    ? 'Push isn’t set up on this server'
    : !pushSupported()
      ? 'Not supported on this device'
      : pushOn
        ? `On for this device${info.devices > 1 ? ` · ${info.devices} devices in total` : ''}`
        : info.devices
          ? `Off here · on for ${info.devices} other device${info.devices === 1 ? '' : 's'}`
          : 'Get reminders even when the app is closed';

  return (
    <section className="card ns">
      <h2>Notifications</h2>

      <div className="ns-row">
        <Bell size={16} />
        <div className="ns-text">
          <div>Push notifications</div>
          <div className="muted small">{pushHint}</div>
        </div>
        <Toggle label="Push on this device" checked={!!pushOn} disabled={busy || !info?.publicKey || !pushSupported() || pushOn === null} onChange={() => void togglePush()} />
      </div>

      <div className="ns-row">
        <Mail size={16} />
        <div className="ns-text">
          <div>Email reminders</div>
          <div className="muted small">{info && !info.emailAvailable ? 'Email isn’t set up on this server' : 'Reminders and the daily digest by email'}</div>
        </div>
        <Toggle label="Email reminders" checked={s.emailEnabled} onChange={(v) => void save({ emailEnabled: v })} />
      </div>

      <div className="ns-row">
        <Clock size={16} />
        <div className="ns-text">
          <div>Default reminder time</div>
          <div className="muted small">For tasks with a date but no time</div>
        </div>
        <input type="time" className="input input-sm" aria-label="Default reminder time" value={s.defaultReminderTime} onChange={(e) => e.target.value && void save({ defaultReminderTime: e.target.value })} />
      </div>

      <div className="ns-row">
        <Globe size={16} />
        <div className="ns-text">
          <div>Time zone</div>
          <div className="muted small">
            Due dates and reminders use this zone
            {s.timeZone !== browserTz && (
              <>
                {' · '}
                <button type="button" className="link-btn" onClick={() => void save({ timeZone: browserTz })}>
                  Use {browserTz}
                </button>
              </>
            )}
          </div>
        </div>
        <select className="input input-sm ns-tz" aria-label="Time zone" value={s.timeZone} onChange={(e) => void save({ timeZone: e.target.value })}>
          {allTimeZones().map((tz) => (
            <option key={tz} value={tz}>
              {tz.replace(/_/g, ' ')}
            </option>
          ))}
        </select>
      </div>

      <div className="ns-row">
        <Mail size={16} />
        <div className="ns-text">
          <div>Daily digest</div>
          <div className="muted small">An email with today’s and overdue tasks</div>
        </div>
        {s.digestEnabled && (
          <input type="time" className="input input-sm" aria-label="Digest time" value={s.digestTime} onChange={(e) => e.target.value && void save({ digestTime: e.target.value })} />
        )}
        <Toggle label="Daily digest" checked={s.digestEnabled} disabled={!s.emailEnabled} onChange={(v) => void save({ digestEnabled: v })} />
      </div>

      <button type="button" className="btn btn-secondary btn-sm ns-test" onClick={() => void sendTest()}>
        <Send size={14} /> Send a test notification
      </button>
    </section>
  );
}

function Toggle({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-label={label} aria-checked={checked} disabled={disabled} className={`ns-switch ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}
