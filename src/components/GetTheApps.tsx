// "Get the apps": download links for the desktop and mobile apps, shown in the web app only
// (Settings > Get the apps, and the user menu). The desktop installers come from the marketing
// site's mirror of the latest GitHub release (stable file names, site/nginx.conf `/download/`),
// so these links never change between releases. The device you're on is listed first.
import { Monitor, Smartphone } from 'lucide-react';
import { APP_STORE_URL, DOWNLOADS_URL, SITE_URL } from '../../shared/config.ts';

export type DeviceOS = 'mac' | 'windows' | 'ios' | 'android' | 'other';

/** The visitor's OS from the user agent (iPadOS reports as a Mac with touch). Exported for tests. */
export function deviceOS(ua: string, touchPoints = 0): DeviceOS {
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/Macintosh|Mac OS X/.test(ua)) return 'mac';
  if (/Windows/.test(ua)) return 'windows';
  return 'other';
}

interface AppRow {
  os: Exclude<DeviceOS, 'other'>;
  title: string;
  detail: string;
  href: string;
  action: string;
  extra?: { href: string; label: string };
}

export const APP_ROWS: AppRow[] = [
  {
    os: 'mac',
    title: 'Mac',
    detail: 'Universal app for Apple silicon and Intel. Open the .dmg and drag Notivelo to Applications.',
    href: `${DOWNLOADS_URL}/Notivelo-mac.dmg`,
    action: 'Download for Mac',
  },
  {
    os: 'windows',
    title: 'Windows',
    detail: 'Installer for 64-bit Windows. The app keeps itself up to date.',
    href: `${DOWNLOADS_URL}/Notivelo-windows-setup.exe`,
    action: 'Download for Windows',
    extra: { href: `${DOWNLOADS_URL}/Notivelo-windows.msi`, label: '.msi for deployment' },
  },
  {
    os: 'ios',
    title: 'iPhone and iPad',
    detail: 'Notivelo on the App Store.',
    href: APP_STORE_URL,
    action: 'View on the App Store',
  },
  {
    os: 'android',
    title: 'Android',
    detail: 'Open Notivelo in Chrome, then choose Install app (or Add to Home screen) from the ⋮ menu.',
    href: `${SITE_URL}/guide/offline-and-devices`,
    action: 'How to install',
  },
];

export function GetTheApps() {
  const here = deviceOS(navigator.userAgent, navigator.maxTouchPoints ?? 0);
  const rows = [...APP_ROWS].sort((a, b) => Number(b.os === here) - Number(a.os === here));
  return (
    <section className="card get-apps">
      <p className="muted small card-desc">
        Notivelo works right here in your browser. The apps add a window of their own, a tray or menu-bar icon,
        quick capture and notifications. Everything stays in sync.
      </p>
      <ul className="get-apps-list">
        {rows.map((r) => (
          <li key={r.os} className="setting-row" data-testid={`get-app-${r.os}`}>
            <span className="get-apps-icon" aria-hidden>
              {r.os === 'mac' || r.os === 'windows' ? <Monitor size={18} /> : <Smartphone size={18} />}
            </span>
            <div className="grow">
              <div className="setting-title">
                {r.title}
                {r.os === here && <span className="get-apps-here"> · this device</span>}
              </div>
              <div className="muted small">{r.detail}</div>
            </div>
            <div className="get-apps-actions">
              <a className={`btn btn-sm ${r.os === here ? 'btn-primary' : 'btn-secondary'}`} href={r.href} target="_blank" rel="noopener noreferrer">
                {r.action}
              </a>
              {r.extra && (
                <a className="small" href={r.extra.href} target="_blank" rel="noopener noreferrer">
                  {r.extra.label}
                </a>
              )}
            </div>
          </li>
        ))}
      </ul>
      <p className="muted small">
        All downloads and versions are also on <a href={`${SITE_URL}/download`} target="_blank" rel="noopener noreferrer">notiveloapp.com/download</a>.
      </p>
    </section>
  );
}
