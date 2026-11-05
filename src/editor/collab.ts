// Collaboration wiring for the note editor: the page's Y.Doc, the WebSocket
// provider (/collab/<pageId>), the IndexedDB offline cache, presence and the
// TipTap collaboration extensions.
//
// Owner: Collaboration (agent 4) may take this file over for cursors/presence;
// NoteEditor only uses the exports below.
import { useEffect, useMemo, useState } from 'react';
import type { Extensions } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';
import { refreshSession, wsProtocols, wsUrl } from '../api.ts';
import type { User } from '../../shared/types.ts';

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
  /** True once the server's copy has been merged (so "empty" really means empty). */
  serverSynced: boolean;
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
  const [serverSynced, setServerSynced] = useState(false);

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
      setServerSynced(true);
      // Offline edits were just pushed by the sync handshake.
      if (dirty) settle();
      else report();
    };
    const onUpdate = (_u: Uint8Array, origin: unknown) => {
      if (origin === provider || origin === idb) return; // remote or cached, not a local edit
      dirty = true;
      report();
      if (connected) settle();
    };
    idb.once('synced', () => setSynced(true));
    provider.on('status', onStatusEv);
    provider.on('sync', onSync);
    doc.on('update', onUpdate);
    provider.on('connection-close', (ev: CloseEvent | null) => {
      if (ev?.code === 4401) {
        // Access token expired or rejected: refresh, then reconnect with the new one.
        provider.shouldConnect = false;
        refreshSession()
          .then((s) => s && provider.connect())
          .catch(() => provider.connect());
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
      if (timer) clearTimeout(timer);
      doc.off('update', onUpdate);
      provider.awareness.off('change', onAwareness);
      provider.destroy();
      void idb.destroy();
      doc.destroy();
    };
  }, [doc, provider]); // eslint-disable-line react-hooks/exhaustive-deps

  return { doc, provider, synced, serverSynced };
}

/** TipTap extensions that bind the editor to the shared doc and show other people's carets. */
export function collabExtensions(session: CollabSession, user: User): Extensions {
  return [
    Collaboration.configure({ document: session.doc, field: 'default' }),
    CollaborationCaret.configure({
      provider: session.provider,
      user: { id: user.id, name: user.name, color: user.color },
    }),
  ];
}
