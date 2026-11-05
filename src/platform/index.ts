// The platform adapter in use. See types.ts for what belongs here.
import type { Platform, PlatformKind } from './types.ts';
import { webPlatform } from './web.ts';

export type { Platform, PlatformKind, NotificationPermission } from './types.ts';
export { parseDeepLink, type DeepLinkTarget } from './deepLinks.ts';

export function detectPlatform(): PlatformKind {
  const g = globalThis as Record<string, unknown>;
  if ('__TAURI_INTERNALS__' in g) return 'tauri';
  const cap = g.Capacitor as { isNativePlatform?: () => boolean } | undefined;
  if (cap?.isNativePlatform?.()) return 'capacitor';
  return 'web';
}

/** Use `platform.*` everywhere; it is replaced by the shell implementation in initPlatform(). */
export let platform: Platform = webPlatform;

export async function initPlatform() {
  // Shell implementations are loaded lazily so the web bundle doesn't carry them:
  //   if (detectPlatform() === 'tauri') platform = (await import('./tauri.ts')).tauriPlatform;
  //   if (detectPlatform() === 'capacitor') platform = (await import('./capacitor.ts')).capacitorPlatform;
  await platform.init();
}

/**
 * Send clicks on external links (http/mailto on another origin) to
 * platform.openExternal, so shells open them in the system browser instead of
 * navigating the app's own window.
 */
export function installExternalLinkHandler(): () => void {
  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0) return;
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!a || a.closest('[contenteditable="true"]')) return; // editor handles its own links
    const url = new URL(a.href, location.href);
    const external = url.protocol === 'mailto:' || ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== location.origin);
    if (!external) return;
    e.preventDefault();
    platform.openExternal(url.href);
  };
  document.addEventListener('click', onClick);
  return () => document.removeEventListener('click', onClick);
}
