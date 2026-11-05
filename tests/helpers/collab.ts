// Test helper: a real y-websocket client (the same provider the editor uses)
// connected through the test server's /collab socket with a bearer token.
import WS from 'ws';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import type { TestApp } from './app.ts';

export interface CollabClient {
  doc: Y.Doc;
  provider: WebsocketProvider;
  /** Close codes the provider saw, newest last. */
  closes: number[];
  text: () => string;
  destroy: () => void;
}

export function collabClient(app: TestApp, pageId: string, token: string, user?: { id: string; name: string; color: string }): CollabClient {
  class AuthedWS extends WS {
    constructor(url: string | URL) {
      super(url, ['noteapp.v1', `bearer.${token}`]);
    }
  }
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(`${app.wsOrigin}/collab`, pageId, doc, {
    WebSocketPolyfill: AuthedWS as unknown as typeof WebSocket,
    disableBc: true, // tests run in one process: don't let clients sync behind the server's back
  });
  const closes: number[] = [];
  provider.on('connection-close', (ev: CloseEvent | null) => {
    if (ev) closes.push(ev.code);
    if (ev?.code === 4401 || ev?.code === 4403) provider.shouldConnect = false;
  });
  if (user) provider.awareness.setLocalStateField('user', user);
  return {
    doc,
    provider,
    closes,
    text: () => paragraphText(doc),
    destroy: () => {
      provider.destroy();
      doc.destroy();
    },
  };
}

/** Text of all paragraphs, newline separated. */
export function paragraphText(doc: Y.Doc): string {
  return doc
    .getXmlFragment('default')
    .toArray()
    .map((n) => (n instanceof Y.XmlElement ? n.toArray().map((t) => (t instanceof Y.XmlText ? t.toString() : '')).join('') : ''))
    .join('\n');
}

export function waitFor(cond: () => boolean, ms = 3000, what = 'condition'): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - start > ms) return reject(new Error(`timed out waiting for ${what}`));
      setTimeout(tick, 15);
    };
    tick();
  });
}

export const synced = (c: CollabClient) => waitFor(() => c.provider.synced, 3000, 'sync');
