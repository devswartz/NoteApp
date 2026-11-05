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

type ShellLoaders = Partial<Record<PlatformKind, () => Promise<Platform>>>;

// Shell implementations are loaded lazily (dynamic import → separate chunk) so
// the web app never downloads them.
const shells: ShellLoaders = {
  tauri: () => import('./tauri.ts').then((m) => m.tauriPlatform),
  //   capacitor: () => import('./capacitor.ts').then((m) => m.capacitorPlatform),
};

/** The implementation for `kind`; the web one when there is no shell implementation. */
export async function loadPlatform(kind: PlatformKind, loaders: ShellLoaders = shells): Promise<Platform> {
  const load = kind === 'web' ? undefined : loaders[kind];
  return load ? load() : webPlatform;
}

export async function initPlatform() {
  platform = await loadPlatform(detectPlatform());
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
