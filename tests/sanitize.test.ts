// F10: a hand-built Yjs update must not be able to put non-XML types or absurd nesting into page content.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import WS from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import { startTestApp, type TestApp } from './helpers/app.ts';
import { collabClient, synced, waitFor } from './helpers/collab.ts';
/** server/collab.ts MAX_NODE_DEPTH (not imported: server modules must load after startTestApp sets the env). */
const MAX_NODE_DEPTH = 64;

let app: TestApp;
before(async () => {
  app = await startTestApp();
});
after(() => app.close());

let n = 0;
async function newPage() {
  const u = await app.signUp('San' + (n++));
  const tree = await app.call('GET', `/workspaces/${u.wsId}/tree`, u.token);
  const pageId = (await app.call('POST', `/sections/${tree.data.sections[0].id}/pages`, u.token, { title: 'P' })).data.id;
  return { u, pageId };
}

/** Sends `update` as a raw sync message, like a hostile client would. */
async function sendRaw(token: string, pageId: string, update: Uint8Array) {
  const ws = new WS(`${app.wsOrigin}/collab/${pageId}`, ['noteapp.v1', `bearer.${token}`]);
  await new Promise((r, j) => (ws.on('open', r), ws.on('error', j)));
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0);
  syncProtocol.writeUpdate(enc, update);
  ws.send(encoding.toUint8Array(enc));
  return ws;
}

/** Deepest element nesting under `root` (iterative), or -1 if anything but XmlElement / XmlText is in there. */
function check(root: Y.XmlFragment): number {
  let max = 0;
  const stack: [Y.XmlFragment | Y.XmlElement, number][] = [[root, 0]];
  while (stack.length) {
    const [n, d] = stack.pop()!;
    max = Math.max(max, d);
    for (const c of n.toArray()) {
      if (c instanceof Y.XmlText) continue;
      if (!(c instanceof Y.XmlElement)) return -1;
      stack.push([c, d + 1]);
    }
  }
  return max;
}
const attrsPlain = (n: Y.XmlElement) => (Object.values(n.getAttributes()) as unknown[]).every((v: unknown) => !(v instanceof Y.AbstractType));

function goodParagraph(text: string) {
  const p = new Y.XmlElement('paragraph');
  p.insert(0, [new Y.XmlText(text)]);
  return p;
}

/** Pushes a chain of n nested blockquotes into frag, attaching each level before adding the next (a prelim tree this deep overflows Yjs recursion). */
function pushChain(frag: Y.XmlFragment, n: number) {
  const top = new Y.XmlElement('blockquote');
  frag.push([top]);
  let cur = top;
  for (let i = 0; i < n; i++) {
    const next = new Y.XmlElement('blockquote');
    cur.insert(0, [next]);
    cur = next;
  }
}

test('F10: a Y.Map / Y.Array / Y.Text in a fragment or element is removed, and a second client never gets it', async () => {
  const { u, pageId } = await newPage();
  const watcher = collabClient(app, pageId, u.token);
  await synced(watcher);
  let sawBad = false;
  watcher.doc.getXmlFragment('default').observeDeep((events) => {
    for (const ev of events) {
      for (const item of ev.changes.added) {
        const content = (item.content as { getContent(): unknown[] }).getContent();
        if (!content.every((c) => c instanceof Y.XmlElement || c instanceof Y.XmlText)) sawBad = true;
      }
    }
  });

  const doc = new Y.Doc();
  const frag = doc.getXmlFragment('default');
  const p = goodParagraph('keep me');
  frag.push([p]);
  p.insert(1, [new Y.Map(), new Y.Array(), new Y.Text('t')] as unknown as Y.XmlElement[]);
  p.setAttribute('x', new Y.Map() as unknown as string);
  frag.insert(0, [new Y.Map() as unknown as Y.XmlElement]);
  const ws = await sendRaw(u.token, pageId, Y.encodeStateAsUpdate(doc));

  const f = watcher.doc.getXmlFragment('default');
  await waitFor(() => f.length === 1 && check(f) === 1, 3000, 'cleaned doc');
  assert.equal(watcher.text(), 'keep me');
  assert.ok(attrsPlain(f.get(0) as Y.XmlElement));
  assert.equal(sawBad, false, 'the bad nodes were never delivered');

  // A client joining afterwards gets the clean doc too, and the server's stored copy is clean.
  const late = collabClient(app, pageId, u.token);
  await synced(late);
  assert.equal(check(late.doc.getXmlFragment('default')), 1);
  assert.equal(late.text(), 'keep me');
  await new Promise((r) => setTimeout(r, 1300));
  const { db } = await import('../server/db.ts');
  const stored = new Y.Doc();
  Y.applyUpdate(stored, new Uint8Array((db.prepare('SELECT ydoc FROM pages WHERE id = ?').get(pageId) as { ydoc: Buffer }).ydoc));
  assert.equal(check(stored.getXmlFragment('default')), 1);
  ws.close();
  watcher.destroy();
  late.destroy();
});

test('F10: junk in a canvas box fragment is removed but the boxes and settings maps are left alone', async () => {
  const { u, pageId } = await newPage();
  const c = collabClient(app, pageId, u.token);
  await synced(c);
  const g = new Y.Map<unknown>();
  g.set('x', 1);
  c.doc.getMap<unknown>('boxes').set('b1', g);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(c.doc));
  doc.getXmlFragment('box:b1').push([new Y.Map() as unknown as Y.XmlElement, goodParagraph('boxed')]);
  doc.getMap('pageSettings').set('color', 'blue');
  const ws = await sendRaw(u.token, pageId, Y.encodeStateAsUpdate(doc));
  const f = c.doc.getXmlFragment('box:b1');
  await waitFor(() => f.length === 1 && check(f) === 1, 3000, 'box cleaned');
  assert.ok(c.doc.getMap('boxes').get('b1') instanceof Y.Map, 'box geometry untouched');
  assert.equal(c.doc.getMap('pageSettings').get('color'), 'blue');
  ws.close();
  c.destroy();
});

test('F10: deep nesting is capped', async () => {
  const { u, pageId } = await newPage();
  const watcher = collabClient(app, pageId, u.token);
  await synced(watcher);
  const doc = new Y.Doc();
  pushChain(doc.getXmlFragment('default'), 3000);
  doc.getXmlFragment('default').push([goodParagraph('after')]);
  const ws = await sendRaw(u.token, pageId, Y.encodeStateAsUpdate(doc));
  const f = watcher.doc.getXmlFragment('default');
  await waitFor(() => f.length === 2 && check(f) > 0 && check(f) <= MAX_NODE_DEPTH, 8000, 'depth capped');
  assert.equal(check(f), MAX_NODE_DEPTH);
  assert.equal(watcher.text(), '\nafter');
  ws.close();
  watcher.destroy();
});

test('F10: normal content, nested structure and typing are untouched', async () => {
  const { u, pageId } = await newPage();
  const a = collabClient(app, pageId, u.token);
  const b = collabClient(app, pageId, u.token);
  await synced(a);
  await synced(b);
  const frag = a.doc.getXmlFragment('default');
  a.doc.transact(() => {
    const list = new Y.XmlElement('bulletList');
    const item = new Y.XmlElement('listItem');
    item.insert(0, [goodParagraph('nested')]);
    list.insert(0, [item]);
    list.setAttribute('kind', 'x');
    frag.push([list, goodParagraph('one')]);
  });
  await waitFor(() => b.doc.getXmlFragment('default').length === 2, 3000, 'b sees content');
  const t = (frag.get(1) as Y.XmlElement).get(0) as Y.XmlText;
  for (const ch of ' two three') t.insert(t.length, ch);
  await waitFor(() => (b.doc.getXmlFragment('default').get(1) as Y.XmlElement).toString().includes('one two three'), 3000, 'typing syncs');
  assert.equal(check(b.doc.getXmlFragment('default')), 3);
  assert.equal((b.doc.getXmlFragment('default').get(0) as Y.XmlElement).getAttribute('kind'), 'x');
  a.destroy();
  b.destroy();
});

test('F10: a stored bad doc is cleaned when its room loads', async () => {
  const { u, pageId } = await newPage();
  const doc = new Y.Doc();
  const frag = doc.getXmlFragment('default');
  frag.push([goodParagraph('stored'), new Y.Map() as unknown as Y.XmlElement]);
  pushChain(frag, 500);
  (frag.get(0) as Y.XmlElement).insert(1, [new Y.Array() as unknown as Y.XmlElement]);
  const { db } = await import('../server/db.ts');
  db.prepare('UPDATE pages SET ydoc = ? WHERE id = ?').run(Buffer.from(Y.encodeStateAsUpdate(doc)), pageId);
  const c = collabClient(app, pageId, u.token);
  await synced(c);
  const f = c.doc.getXmlFragment('default');
  assert.equal(check(f), MAX_NODE_DEPTH);
  assert.equal(f.length, 2);
  assert.equal(c.text(), 'stored\n');
  c.destroy();
});
