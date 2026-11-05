// Collaboration wiring for the note editor: the page's Y.Doc, the WebSocket
// provider (/collab/<pageId>), the IndexedDB offline cache, presence and the
// TipTap collaboration extensions.
//
// Owner: Collaboration (agent 4) may take this file over for cursors/presence;
// NoteEditor only uses the exports below.
import { useEffect, useMemo, useState } from 'react';
import { Extension, type Extensions } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { ReplaceStep } from '@tiptap/pm/transform';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';
import { backoffMs, reauthorize, wsProtocols, wsUrl } from '../api.ts';
import type { User } from '../../shared/types.ts';
import { toast } from '../store/toasts.ts';

export type SyncStatus = 'connecting' | 'live' | 'offline';
/** What the page header shows: is everything I typed safely on the server? */
export type SaveState = 'saved' | 'saving' | 'offline';

export interface PresenceUser {
  id: string;
  name: string;
  color: string;
}

/** y-websocket opens sockets itself; this subclass adds the current access token on every (re)connect. */
class AuthedWebSocket extends WebSocket {
  constructor(url: string | URL) {
    super(url, wsProtocols());
  }
}

/** The server persists a room 1 s after the last update (server/collab.ts SAVE_DEBOUNCE_MS). */
const SERVER_SAVE_DELAY_MS = 1100;

export interface CollabSession {
  doc: Y.Doc;
  provider: WebsocketProvider;
  /** True once the doc has content from IndexedDB or the server. */
  synced: boolean;
}

interface Callbacks {
  onStatus: (s: SyncStatus) => void;
  onPresence: (users: PresenceUser[]) => void;
  onSave?: (s: SaveState) => void;
}

/** One Y.Doc + providers per page. The calling component must be keyed by page id. */
export function useCollab(pageId: string, user: User, cb: Callbacks): CollabSession {
  const { doc, provider } = useMemo(() => {
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(wsUrl('/collab'), pageId, doc, { WebSocketPolyfill: AuthedWebSocket });
    return { doc, provider };
  }, [pageId]);
  const [synced, setSynced] = useState(false);

  useEffect(() => {
    // Local cache for offline reading/editing; merges when the socket reconnects.
    const idb = new IndexeddbPersistence(`noteapp-page-${pageId}`, doc);
    let connected = false;
    let dirty = false; // local edits the server may not have persisted yet
    let timer: ReturnType<typeof setTimeout> | null = null;
    const report = () => cb.onSave?.(!connected ? 'offline' : dirty ? 'saving' : 'saved');
    const settle = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function check() {
        const ws = provider.ws;
        // Wait until the socket has flushed what we sent, then for the server's save debounce.
        if (ws && ws.bufferedAmount > 0) {
          timer = setTimeout(check, 200);
          return;
        }
        if (connected && provider.synced) {
          dirty = false;
          report();
        }
      }, SERVER_SAVE_DELAY_MS);
    };

    const onStatusEv = ({ status }: { status: string }) => {
      connected = status === 'connected';
      cb.onStatus(connected ? 'live' : status === 'connecting' ? 'connecting' : 'offline');
      report();
    };
    const onSync = (s: boolean) => {
      if (!s) return;
      setSynced(true);
      // Offline edits were just pushed by the sync handshake.
      if (dirty) settle();
      else report();
    };
    // Set when the server refused a change as too large: nothing syncs until the page is reloaded.
    let tooLarge = false;
    let lastWarn = 0;
    const warnTooLarge = () => {
      if (Date.now() - lastWarn < 5000) return;
      lastWarn = Date.now();
      toast('A change on this page is too large to sync, so this page isn’t saving. Reload to continue from the saved version.', {
        tone: 'error',
        action: {
          label: 'Reload page',
          run: () => {
            // Drop the local cache too, or the oversized change would be sent again.
            void idb.clearData().finally(() => location.reload());
          },
        },
      });
    };
    const onUpdate = (_u: Uint8Array, origin: unknown) => {
      if (origin === provider || origin === idb) return; // remote or cached, not a local edit
      if (tooLarge) warnTooLarge(); // keep telling them while their edits can't be saved
      dirty = true;
      report();
      if (connected) settle();
    };
    idb.once('synced', () => setSynced(true));
    provider.on('status', onStatusEv);
    provider.on('sync', onSync);
    doc.on('update', onUpdate);
    // 4401 (token expired/rejected): refresh, then reconnect with backoff. The
    // counter resets only after the socket has stayed up for a while, because
    // the server accepts the socket before rejecting it.
    let authFailures = 0;
    let healthy: ReturnType<typeof setTimeout> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let destroyed = false;
    provider.on('status', ({ status }: { status: string }) => {
      clearTimeout(healthy);
      if (status === 'connected') healthy = setTimeout(() => (authFailures = 0), 10_000);
    });
    provider.on('connection-close', (ev: CloseEvent | null) => {
      if (ev?.code === 1009) {
        // The server refused a change as too large (server/collab.ts MAX_SYNC_MESSAGE_BYTES).
        // Reconnecting would resend it forever, so stop, and offer to continue from the saved version.
        provider.shouldConnect = false;
        tooLarge = true;
        cb.onStatus('offline');
        warnTooLarge();
        return;
      }
      if (ev?.code === 4401) {
        provider.shouldConnect = false;
        const delay = authFailures === 0 ? 0 : backoffMs(authFailures);
        authFailures++;
        retry = setTimeout(async () => {
          const r = await reauthorize();
          if (!destroyed && r !== 'signed-out') provider.connect();
        }, delay);
      } else if (ev?.code === 4403) {
        provider.shouldConnect = false; // no access to this page
        cb.onStatus('offline');
      }
    });
    const onAwareness = () => {
      const seen = new Map<string, PresenceUser>();
      provider.awareness.getStates().forEach((s, clientId) => {
        const u = s.user as PresenceUser | undefined;
        if (u && clientId !== doc.clientID && u.id !== user.id) seen.set(u.id, u);
      });
      cb.onPresence([...seen.values()]);
    };
    provider.awareness.on('change', onAwareness);
    return () => {
      destroyed = true;
      clearTimeout(healthy);
      clearTimeout(retry);
      if (timer) clearTimeout(timer);
      doc.off('update', onUpdate);
      provider.awareness.off('change', onAwareness);
      provider.destroy();
      void idb.destroy();
      doc.destroy();
    };
  }, [doc, provider]); // eslint-disable-line react-hooks/exhaustive-deps

  return { doc, provider, synced };
}

/**
 * Largest paste/drop accepted into a page, in document positions (≈ characters).
 * Keeps a single change well under the server's 4 MB message limit even for
 * multi-byte text; bigger content belongs in an attachment.
 */
export const MAX_PASTE_SIZE = 1_000_000;

/** Refuses pastes and drops too large to sync, with an explanation, before they reach the shared doc. */
export const SyncSizeGuard = Extension.create({
  name: 'syncSizeGuard',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('syncSizeGuard'),
        filterTransaction: (tr) => {
          const ui = tr.getMeta('uiEvent');
          if (ui !== 'paste' && ui !== 'drop') return true;
          let size = 0;
          for (const step of tr.steps) if (step instanceof ReplaceStep) size += step.slice.size;
          if (size <= MAX_PASTE_SIZE) return true;
          toast(`That’s too large to add to a page (about ${(size / 1_000_000).toFixed(1)} million characters; the limit is 1 million). Split it up, or attach it as a file.`, {
            tone: 'error',
          });
          return false;
        },
      }),
    ];
  },
});

/** TipTap extensions that bind the editor to the shared doc and show other people's carets. */
export function collabExtensions(session: CollabSession, user: User): Extensions {
  return [
    SyncSizeGuard,
    Collaboration.configure({ document: session.doc, field: 'default' }),
    CollaborationCaret.configure({
      provider: session.provider,
      user: { id: user.id, name: user.name, color: user.color },
    }),
  ];
}
