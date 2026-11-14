// Which server the desktop app talks to. The Rust side decides and injects it
// before the web app loads (apps/desktop/src-tauri/src/config.rs). Release builds
// are locked to the Notivelo server; debug / internal builds (`switchable`) get
// this form behind "Change Server…" (app menu on macOS, command palette elsewhere).
import { invoke } from '@tauri-apps/api/core';
import { button, openDialog } from './dialogs.ts';
import { APP_NAME } from '../../../shared/config.ts';

export interface ServerInfo {
  url: string;
  /** Debug / internal builds only: "Change Server…" is offered. */
  switchable: boolean;
  defaultUrl: string;
}

export function serverInfo(): ServerInfo {
  const injected = (globalThis as { __NOTEAPP_SERVER__?: ServerInfo }).__NOTEAPP_SERVER__;
  return injected ?? { url: '', switchable: false, defaultUrl: '' };
}

/** Checks that a URL answers like our server (GET /api/health → {ok:true}). */
export async function probeServer(url: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const base = (/^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`).replace(/\/+$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetchImpl(`${base}/api/health`, { signal: ctrl.signal });
    const body = (await r.json().catch(() => null)) as { ok?: boolean } | null;
    return r.ok && body?.ok ? null : `That server didn’t answer like a ${APP_NAME} server.`;
  } catch {
    return 'Couldn’t reach that server. Check the address and your connection.';
  } finally {
    clearTimeout(timer);
  }
}

/** Shows the server form (switchable builds only). Saving restarts the app (the promise never resolves then). */
export function showServerSetup(): Promise<void> {
  const info = serverInfo();
  if (!info.switchable) return Promise.resolve();
  return new Promise((resolve) => {
    const d = openDialog('Change server', { dismissable: true });
    const intro = document.createElement('p');
    intro.style.margin = '0';
    intro.textContent = 'Internal build: point the app at staging or a local server. You sign in separately on each server. The app restarts to switch.';
    const input = document.createElement('input');
    input.type = 'url';
    input.value = info.url || info.defaultUrl;
    input.placeholder = info.defaultUrl || 'https://notes.example.com';
    input.setAttribute('aria-label', 'Server address');
    input.spellcheck = false;
    input.className = 'input';
    const error = document.createElement('p');
    error.setAttribute('role', 'alert');
    error.style.cssText = 'margin:0;color:var(--danger,#c00);min-height:1em';
    d.body.append(intro, input, error);

    const save = async () => {
      connect.disabled = true;
      error.textContent = '';
      const problem = await probeServer(input.value);
      if (problem) {
        error.textContent = problem;
        connect.disabled = false;
        return;
      }
      try {
        await invoke('set_server', { url: input.value }); // restarts the app
      } catch (e) {
        error.textContent = String(e);
        connect.disabled = false;
      }
    };
    const connect = button('Connect', 'primary', () => void save());
    d.actions.append(
      button('Cancel', 'secondary', () => {
        d.close();
        resolve();
      }),
    );
    d.actions.append(connect);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void save();
    });
    input.focus();
    input.select();
  });
}
