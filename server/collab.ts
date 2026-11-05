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
import { tokenFromUpgrade, verifyAccessToken } from './auth.ts';
import { onAccessChange, pageAccess } from './access.ts';
import { syncPageTasks } from './tasks.ts';
import { publish } from './events.ts';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const SAVE_DEBOUNCE_MS = 1000;
/** Save at least this often while people keep typing (the debounce alone would wait for a pause). */
const SAVE_MAX_WAIT_MS = 5000;

interface Room {
  pageId: string;
  workspaceId: string;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  conns: Map<WebSocket, Set<number>>; // socket -> awareness client ids it controls
  saveTimer: NodeJS.Timeout | null;
  /** When the oldest unsaved change arrived (0 = nothing pending). */
  dirtySince: number;
  lastEditor: string | null;
  /** People @mentioned in the doc as last saved; only new mentions notify. */
  mentioned: Set<string>;
  /** Who inserted each mention since the last save (mentioned user → the user whose socket sent it). */
  mentionAuthors: Map<string, string>;
}

const rooms = new Map<string, Room>();

/** Set by server/notifications.ts: called with people newly @mentioned when a page is saved, grouped by who added them (null = unknown). */
let pageMentionHook: ((pageId: string, workspaceId: string, userIds: string[], actorId: string | null) => void) | null = null;
export function onPageMentions(fn: typeof pageMentionHook) {
  pageMentionHook = fn;
}

/** Who is on each socket, until when their token is valid, and whether they may edit. */
interface ConnAuth {
  userId: string;
  expiresAt: number;
  canEdit: boolean;
}
const connAuth = new WeakMap<WebSocket, ConnAuth>();
const REVALIDATE_MS = 30_000;

/**
 * Re-check every open collab socket: close it with 4401 when its access token
 * has expired (the client refreshes and reconnects) and with 4403 when the
 * user lost access to the page; pick up edit/view-only changes.
 */
export function revalidateCollab() {
  const t = Date.now();
  for (const room of rooms.values()) {
    for (const conn of [...room.conns.keys()]) {
      const a = connAuth.get(conn);
      if (!a) continue;
      if (t >= a.expiresAt) {
        revoke(conn, a, 4401, 'Token expired');
        continue;
      }
      const access = pageAccess(room.pageId, a.userId);
      if (!access) revoke(conn, a, 4403, 'Access revoked');
      else a.canEdit = access.canEdit;
    }
  }
}
/** Stop accepting edits from this socket now, ask it to close, and cut it off if it doesn't. */
function revoke(conn: WebSocket, a: ConnAuth, code: number, reason: string) {
  a.canEdit = false;
  a.expiresAt = 0;
  conn.close(code, reason);
  setTimeout(() => conn.readyState !== WebSocket.CLOSED && conn.terminate(), 2000).unref();
}

onAccessChange(revalidateCollab);
setInterval(revalidateCollab, REVALIDATE_MS).unref();

/** Walk a ProseMirror-shaped Y.XmlFragment and collect plain text and task references. */
export function extractDoc(fragment: Y.XmlFragment): { text: string; taskIds: Set<string>; mentionIds: Set<string> } {
  const taskIds = new Set<string>();
  const mentionIds = new Set<string>();
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
      } else if (node.nodeName === 'mention') {
        const id = node.getAttribute('id');
        if (typeof id === 'string' && id) mentionIds.add(id);
        const label = node.getAttribute('label');
        if (typeof label === 'string' && label) parts.push(`@${label}`);
      }
    }
    for (const child of node.toArray()) walk(child as Y.XmlElement | Y.XmlText);
    if (node instanceof Y.XmlElement) parts.push('\n');
  };
  walk(fragment);
  return { text: parts.join('').replace(/\n{3,}/g, '\n\n').trim(), taskIds, mentionIds };
}

function persist(room: Room) {
  room.saveTimer = null;
  room.dirtySince = 0;
  const exists = db.prepare('SELECT 1 FROM pages WHERE id = ?').get(room.pageId);
  if (!exists) return; // page deleted while open
  const state = Buffer.from(Y.encodeStateAsUpdate(room.doc));
  const { text, taskIds, mentionIds } = extractDoc(room.doc.getXmlFragment('default'));
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
  const added = [...mentionIds].filter((id) => !room.mentioned.has(id));
  room.mentioned = mentionIds;
  const byActor = new Map<string | null, string[]>();
  for (const id of added) {
    const actor = room.mentionAuthors.get(id) ?? null;
    byActor.set(actor, [...(byActor.get(actor) ?? []), id]);
  }
  room.mentionAuthors.clear();
  for (const [actor, ids] of byActor) pageMentionHook?.(room.pageId, room.workspaceId, ids, actor);
  publish({ type: 'tree', workspaceId: room.workspaceId });
}

function scheduleSave(room: Room) {
  if (room.saveTimer) clearTimeout(room.saveTimer);
  const t = Date.now();
  if (!room.dirtySince) room.dirtySince = t;
  const wait = Math.max(0, Math.min(SAVE_DEBOUNCE_MS, room.dirtySince + SAVE_MAX_WAIT_MS - t));
  room.saveTimer = setTimeout(() => persist(room), wait);
}

function getRoom(pageId: string, workspaceId: string): Room {
  let room = rooms.get(pageId);
  if (room) return room;
  const doc = new Y.Doc({ gc: true });
  const row = db.prepare('SELECT ydoc FROM pages WHERE id = ?').get(pageId) as { ydoc: Buffer | null } | undefined;
  if (row?.ydoc) Y.applyUpdate(doc, new Uint8Array(row.ydoc));
  const awareness = new awarenessProtocol.Awareness(doc);
  awareness.setLocalState(null);
  const r: Room = {
    pageId,
    workspaceId,
    doc,
    awareness,
    conns: new Map(),
    saveTimer: null,
    dirtySince: 0,
    lastEditor: null,
    mentioned: extractDoc(doc.getXmlFragment('default')).mentionIds,
    mentionAuthors: new Map(),
  };

  // Attribute new @mentions to whoever's update inserted them (not just the last editor).
  doc.getXmlFragment('default').observeDeep((events, tr) => {
    const actor = tr.origin instanceof WebSocket ? connAuth.get(tr.origin)?.userId : undefined;
    if (!actor) return;
    const collect = (n: unknown) => {
      if (!(n instanceof Y.XmlElement)) return;
      if (n.nodeName === 'mention') {
        const id = n.getAttribute('id');
        if (typeof id === 'string' && id && !r.mentionAuthors.has(id)) r.mentionAuthors.set(id, actor);
      }
      for (const c of n.toArray()) collect(c);
    };
    for (const ev of events)
      for (const item of ev.changes.added) for (const c of (item.content as { getContent(): unknown[] }).getContent()) collect(c);
  });

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

/** Force-disconnect everyone from a page (e.g. after it is deleted or access changes). */
export function closeRoom(pageId: string) {
  const room = rooms.get(pageId);
  if (!room) return;
  for (const c of [...room.conns.keys()]) c.close(4403, 'Access revoked');
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
    const auth = verifyAccessToken(tokenFromUpgrade(req));
    if (!auth) {
      conn.close(4401, 'Unauthorized');
      return;
    }
    const user = auth.user;
    const access = pageAccess(pageId, user.id);
    if (!access) {
      conn.close(4403, 'No access to this page');
      return;
    }
    const state: ConnAuth = { userId: user.id, expiresAt: auth.expiresAt, canEdit: access.canEdit };
    connAuth.set(conn, state);
    // Close exactly when the token lapses (the 30 s sweep is a backstop).
    const expiry = setTimeout(() => revoke(conn, state, 4401, 'Token expired'), Math.max(0, auth.expiresAt - Date.now()));
    conn.binaryType = 'arraybuffer';
    const room = getRoom(pageId, access.workspaceId);
    room.conns.set(conn, new Set());

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
          if (sub !== syncProtocol.messageYjsSyncStep1 && !state.canEdit) return;
          if (sub !== syncProtocol.messageYjsSyncStep1) room.lastEditor = user.id;
          syncProtocol.readSyncMessage(dec, enc, room.doc, conn);
          if (encoding.length(enc) > 1) send(room, conn, encoding.toUint8Array(enc));
        } else if (type === MSG_AWARENESS) {
          if (state.expiresAt === 0) return; // revoked, closing
          awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(dec), conn);
        }
      } catch (err) {
        console.error('collab message error', err);
      }
    });

    conn.on('close', () => {
      clearInterval(ping);
      clearTimeout(expiry);
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

/** For /api/admin/stats. */
export function collabStats() {
  let connections = 0;
  for (const r of rooms.values()) connections += r.conns.size;
  return { openPages: rooms.size, connections };
}
