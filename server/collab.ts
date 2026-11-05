// Real-time collaborative editing: a Yjs sync server speaking the y-websocket
// protocol. One shared Y.Doc per page, persisted to SQLite (debounced), with
// per-connection permission checks (viewers receive updates but can't send them).
import type { IncomingMessage } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { db, now } from './db.ts';
import { tokenFromUpgrade, verifyToken } from './auth.ts';
import { pageAccess } from './access.ts';
import { syncPageTasks } from './tasks.ts';
import { publish } from './events.ts';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const SAVE_DEBOUNCE_MS = 1000;

interface Room {
  pageId: string;
  workspaceId: string;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  conns: Map<WebSocket, Set<number>>; // socket -> awareness client ids it controls
  peers: Map<WebSocket, Peer>; // socket -> who it is and what it may do
  saveTimer: NodeJS.Timeout | null;
  lastEditor: string | null;
}

interface Peer {
  userId: string;
  canEdit: boolean;
}

const rooms = new Map<string, Room>();

/** Walk a ProseMirror-shaped Y.XmlFragment and collect plain text and task references. */
export function extractDoc(fragment: Y.XmlFragment): { text: string; taskIds: Set<string> } {
  const taskIds = new Set<string>();
  const parts: string[] = [];
  const walk = (node: Y.XmlElement | Y.XmlText | Y.XmlFragment) => {
    if (node instanceof Y.XmlText) {
      parts.push(
        (node.toDelta() as { insert: unknown }[]).map((d) => (typeof d.insert === 'string' ? d.insert : '')).join(''),
      );
      return;
    }
    if (node instanceof Y.XmlElement) {
      if (node.nodeName === 'taskRef') {
        const id = node.getAttribute('taskId');
        if (typeof id === 'string' && id) taskIds.add(id);
      }
    }
    for (const child of node.toArray()) walk(child as Y.XmlElement | Y.XmlText);
    if (node instanceof Y.XmlElement) parts.push('\n');
  };
  walk(fragment);
  return { text: parts.join('').replace(/\n{3,}/g, '\n\n').trim(), taskIds };
}

function persist(room: Room) {
  room.saveTimer = null;
  const exists = db.prepare('SELECT 1 FROM pages WHERE id = ?').get(room.pageId);
  if (!exists) return; // page deleted while open
  const state = Buffer.from(Y.encodeStateAsUpdate(room.doc));
  const { text, taskIds } = extractDoc(room.doc.getXmlFragment('default'));
  db.transaction(() => {
    db.prepare('UPDATE pages SET ydoc = ?, text = ?, updated_at = ?, updated_by = COALESCE(?, updated_by) WHERE id = ?').run(
      state,
      text,
      now(),
      room.lastEditor,
      room.pageId,
    );
    const title = (db.prepare('SELECT title FROM pages WHERE id = ?').get(room.pageId) as { title: string }).title;
    db.prepare('DELETE FROM pages_fts WHERE page_id = ?').run(room.pageId);
    db.prepare('INSERT INTO pages_fts (page_id, title, text) VALUES (?, ?, ?)').run(room.pageId, title, text);
  })();
  syncPageTasks(room.pageId, room.workspaceId, taskIds);
  publish({ type: 'tree', workspaceId: room.workspaceId });
}

function scheduleSave(room: Room) {
  if (room.saveTimer) clearTimeout(room.saveTimer);
  room.saveTimer = setTimeout(() => persist(room), SAVE_DEBOUNCE_MS);
}

function getRoom(pageId: string, workspaceId: string): Room {
  let room = rooms.get(pageId);
  if (room) return room;
  const doc = new Y.Doc({ gc: true });
  const row = db.prepare('SELECT ydoc FROM pages WHERE id = ?').get(pageId) as { ydoc: Buffer | null } | undefined;
  if (row?.ydoc) Y.applyUpdate(doc, new Uint8Array(row.ydoc));
  const awareness = new awarenessProtocol.Awareness(doc);
  awareness.setLocalState(null);
  const r: Room = { pageId, workspaceId, doc, awareness, conns: new Map(), peers: new Map(), saveTimer: null, lastEditor: null };

  doc.on('update', (update: Uint8Array, origin: unknown) => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, update);
    const msg = encoding.toUint8Array(enc);
    for (const c of r.conns.keys()) if (c !== origin) send(r, c, msg);
    scheduleSave(r);
  });

  awareness.on('update', ({ added, updated, removed }: Record<string, number[]>, origin: unknown) => {
    const changed = added.concat(updated, removed);
    if (origin instanceof WebSocket) {
      const ids = r.conns.get(origin);
      if (ids) {
        for (const id of added) ids.add(id);
        for (const id of removed) ids.delete(id);
      }
    }
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_AWARENESS);
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, changed));
    const msg = encoding.toUint8Array(enc);
    for (const c of r.conns.keys()) send(r, c, msg);
  });

  rooms.set(pageId, r);
  return r;
}

function send(room: Room, conn: WebSocket, msg: Uint8Array) {
  if (conn.readyState !== WebSocket.OPEN) return closeConn(room, conn);
  conn.send(msg, (err) => err && closeConn(room, conn));
}

function closeConn(room: Room, conn: WebSocket) {
  const ids = room.conns.get(conn);
  if (!ids) return;
  room.conns.delete(conn);
  room.peers.delete(conn);
  awarenessProtocol.removeAwarenessStates(room.awareness, [...ids], null);
  if (room.conns.size === 0) {
    if (room.saveTimer) {
      clearTimeout(room.saveTimer);
      persist(room);
    }
    room.doc.destroy();
    rooms.delete(room.pageId);
  }
  conn.close();
}

/**
 * Call after a page is deleted, moved or its access changes: disconnects (4403)
 * every socket on it that no longer has access, and updates the edit flag of
 * the rest. With `userId`, only that user's sockets are checked.
 */
export function closeRoom(pageId: string, userId?: string) {
  const room = rooms.get(pageId);
  if (room) recheckRoom(room, userId);
}

function recheckRoom(room: Room, userId?: string) {
  for (const [c, peer] of [...room.peers]) {
    if (userId && peer.userId !== userId) continue;
    const a = pageAccess(room.pageId, peer.userId);
    if (!a) c.close(4403, 'Access revoked');
    else peer.canEdit = a.canEdit;
  }
}

/**
 * Re-check every open connection after permissions change (role change,
 * notebook made private or unshared). Sockets that lost access are closed
 * with 4403; others get their read-only/edit flag updated in place.
 */
export function recheckAccess(filter: { workspaceId?: string; userId?: string } = {}) {
  for (const room of rooms.values()) {
    if (filter.workspaceId && room.workspaceId !== filter.workspaceId) continue;
    recheckRoom(room, filter.userId);
  }
}

/** Seed an empty page with initial content (used for onboarding pages). */
export function seedPageDoc(pageId: string, build: (frag: Y.XmlFragment) => void) {
  const doc = new Y.Doc();
  build(doc.getXmlFragment('default'));
  const { text } = extractDoc(doc.getXmlFragment('default'));
  db.prepare('UPDATE pages SET ydoc = ?, text = ? WHERE id = ?').run(Buffer.from(Y.encodeStateAsUpdate(doc)), text, pageId);
  const title = (db.prepare('SELECT title FROM pages WHERE id = ?').get(pageId) as { title: string }).title;
  db.prepare('DELETE FROM pages_fts WHERE page_id = ?').run(pageId);
  db.prepare('INSERT INTO pages_fts (page_id, title, text) VALUES (?, ?, ?)').run(pageId, title, text);
}

export function attachCollab(wss: WebSocketServer) {
  wss.on('connection', (conn: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? '', 'http://x');
    // y-websocket connects to `${serverUrl}/${roomName}`; room = page id.
    const pageId = decodeURIComponent(url.pathname.split('/').pop() ?? '');
    const user = verifyToken(tokenFromUpgrade(req));
    const access = user ? pageAccess(pageId, user.id) : null;
    if (!user || !access) {
      conn.close(4401, 'Unauthorized');
      return;
    }
    conn.binaryType = 'arraybuffer';
    const room = getRoom(pageId, access.workspaceId);
    room.conns.set(conn, new Set());
    const peer: Peer = { userId: user.id, canEdit: access.canEdit };
    room.peers.set(conn, peer);

    let alive = true;
    conn.on('pong', () => (alive = true));
    const ping = setInterval(() => {
      if (!alive) return closeConn(room, conn);
      alive = false;
      conn.ping();
    }, 30_000);

    conn.on('message', (data: ArrayBuffer) => {
      try {
        const dec = decoding.createDecoder(new Uint8Array(data));
        const enc = encoding.createEncoder();
        const type = decoding.readVarUint(dec);
        if (type === MSG_SYNC) {
          encoding.writeVarUint(enc, MSG_SYNC);
          // Peek at the sync sub-type so read-only users can't push updates.
          const sub = decoding.peekVarUint(dec);
          if (sub !== syncProtocol.messageYjsSyncStep1 && !peer.canEdit) return;
          if (sub !== syncProtocol.messageYjsSyncStep1) room.lastEditor = user.id;
          syncProtocol.readSyncMessage(dec, enc, room.doc, conn);
          if (encoding.length(enc) > 1) send(room, conn, encoding.toUint8Array(enc));
        } else if (type === MSG_AWARENESS) {
          awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(dec), conn);
        }
      } catch (err) {
        console.error('collab message error', err);
      }
    });

    conn.on('close', () => {
      clearInterval(ping);
      closeConn(room, conn);
    });

    // Initial sync: send our state vector and current awareness states.
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, room.doc);
    send(room, conn, encoding.toUint8Array(enc));
    const states = room.awareness.getStates();
    if (states.size) {
      const a = encoding.createEncoder();
      encoding.writeVarUint(a, MSG_AWARENESS);
      encoding.writeVarUint8Array(a, awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...states.keys()]));
      send(room, conn, encoding.toUint8Array(a));
    }
  });
}

export function flushAll() {
  for (const room of rooms.values()) if (room.saveTimer) {
    clearTimeout(room.saveTimer);
    persist(room);
  }
}

/** Save every open document and disconnect its clients (on shutdown). 1012 = service restart; clients reconnect. */
export function shutdownCollab() {
  flushAll();
  for (const room of rooms.values()) for (const c of room.conns.keys()) c.close(1012, 'Server restarting');
}
