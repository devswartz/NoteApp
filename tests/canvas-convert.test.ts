// Canvas pages, phase 3: converting between a document and a canvas (pure, on the live
// collab room, and on a stored doc), restoring content across kinds, and templates that
// keep their kind.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { BOXES_KEY, CONVERTED_BOX_W, boxField, boxGeoms, convertPageDoc, docKind, fragmentIsEmpty, replacePageContent } from '../shared/pageDoc.ts';
import { startTestApp, type TestApp, type TestUser } from './helpers/app.ts';
import { collabClient, synced, type CollabClient } from './helpers/collab.ts';

let app: TestApp;
let u: TestUser;
let sec: string;
const open: CollabClient[] = [];
before(async () => {
  app = await startTestApp();
  u = await app.signUp('Conny Convert');
  sec = (await app.call('GET', `/workspaces/${u.wsId}/tree`, u.token)).data.sections[0].id;
});
after(async () => {
  for (const c of open) c.destroy();
  await app.close();
});

let n = 0;
const ids = () => `b${++n}`;
const para = (text: string, attrs?: Record<string, unknown>) => {
  const p = new Y.XmlElement('paragraph');
  const t = new Y.XmlText();
  p.insert(0, [t]);
  t.insert(0, text, attrs);
  return p;
};
const taskRef = (taskId: string) => {
  const e = new Y.XmlElement('taskRef');
  e.setAttribute('taskId', taskId);
  return e;
};
function addBox(doc: Y.Doc, id: string, x: number, y: number, blocks: Y.XmlElement[]) {
  doc.transact(() => {
    const m = new Y.Map<number>();
    doc.getMap(BOXES_KEY).set(id, m);
    m.set('x', x);
    m.set('y', y);
    m.set('w', 300);
    m.set('z', 1);
    doc.getXmlFragment(boxField(id)).insert(0, blocks);
  });
}
const plain = (f: Y.XmlFragment) => f.toString().replace(/<[^>]+>/g, '|').replace(/\|+/g, '|');

test('document → canvas: the whole content becomes one box at the top left, marks and tasks kept, in one transaction', () => {
  const doc = new Y.Doc();
  doc.getXmlFragment('default').insert(0, [para('Intro', { bold: true }), taskRef('t-9'), para('End')]);
  let transactions = 0;
  doc.on('afterTransaction', () => transactions++);
  const id = convertPageDoc(doc, 'canvas', ids);
  assert.equal(transactions, 1);
  assert.ok(id);
  assert.equal(doc.getXmlFragment('default').length, 0);
  assert.deepEqual(boxGeoms(doc), [{ id, x: 0, y: 0, w: CONVERTED_BOX_W, z: 1 }]);
  const box = doc.getXmlFragment(boxField(id!));
  assert.equal(box.length, 3);
  assert.equal((box.get(1) as Y.XmlElement).getAttribute('taskId'), 't-9');
  assert.deepEqual(((box.get(0) as Y.XmlElement).get(0) as Y.XmlText).toDelta(), [{ insert: 'Intro', attributes: { bold: true } }]);
  assert.equal(docKind(doc), 'canvas');
});

test('an empty document becomes an empty canvas (no box)', () => {
  const doc = new Y.Doc();
  doc.getXmlFragment('default').insert(0, [new Y.XmlElement('paragraph')]);
  assert.ok(fragmentIsEmpty(doc.getXmlFragment('default')));
  assert.equal(convertPageDoc(doc, 'canvas', ids), null);
  assert.equal(doc.getMap(BOXES_KEY).size, 0);
  assert.equal(doc.getXmlFragment('default').length, 0);
});

test('canvas → document: boxes joined in reading order, empty boxes dropped, boxes removed', () => {
  const doc = new Y.Doc();
  addBox(doc, 'right', 400, 0, [para('Right')]);
  addBox(doc, 'below', 0, 300, [para('Below'), taskRef('t-1')]);
  addBox(doc, 'left', 0, 0, [para('Left')]);
  addBox(doc, 'empty', 10, 10, [new Y.XmlElement('paragraph')]);
  convertPageDoc(doc, 'document', ids);
  assert.equal(doc.getMap(BOXES_KEY).size, 0);
  assert.equal(plain(doc.getXmlFragment('default')), '|Left|Right|Below|');
  assert.equal(doc.getXmlFragment(boxField('left')).length, 0);
  // And back: one box holding all of it.
  const id = convertPageDoc(doc, 'canvas', ids)!;
  assert.equal(plain(doc.getXmlFragment(boxField(id))), '|Left|Right|Below|');
});

test('replacePageContent restores a document version onto a canvas page as one box, keeping box ids otherwise', () => {
  const version = new Y.Doc();
  version.getXmlFragment('default').insert(0, [para('Old text')]);
  const live = new Y.Doc();
  addBox(live, 'now', 50, 50, [para('Current')]);
  replacePageContent(live, version, 'canvas', ids);
  const boxes = boxGeoms(live);
  assert.equal(boxes.length, 1);
  assert.equal(plain(live.getXmlFragment(boxField(boxes[0]!.id))), '|Old text|');
  assert.equal(live.getXmlFragment(boxField('now')).length, 0);

  const canvasVersion = new Y.Doc();
  addBox(canvasVersion, 'kept', 120, 40, [para('Was here')]);
  replacePageContent(live, canvasVersion, 'canvas', ids);
  assert.deepEqual(boxGeoms(live), [{ id: 'kept', x: 120, y: 40, w: 300, z: 1 }]);
});

const kindOf = async (pageId: string) =>
  ((await app.call('GET', `/workspaces/${u.wsId}/tree`, u.token)).data.pages as { id: string; kind: string }[]).find((p) => p.id === pageId)?.kind;

test('POST /pages/:id/convert on an open page: every client gets the change live; kind and search follow', async () => {
  const pageId = (await app.call('POST', `/sections/${sec}/pages`, u.token, { title: 'Live convert' })).data.id as string;
  const a = collabClient(app, pageId, u.token);
  const b = collabClient(app, pageId, u.token);
  open.push(a, b);
  await Promise.all([synced(a), synced(b)]);
  a.doc.getXmlFragment('default').insert(0, [para('Quokka minutes'), taskRef('t-x')]);
  await new Promise((r) => setTimeout(r, 300));

  const r = await app.call('POST', `/pages/${pageId}/convert`, u.token, { kind: 'canvas' });
  assert.equal(r.status, 200);
  assert.equal(await kindOf(pageId), 'canvas');
  for (let i = 0; i < 25 && b.doc.getMap(BOXES_KEY).size === 0; i++) await new Promise((res) => setTimeout(res, 100));
  const [box] = boxGeoms(b.doc);
  assert.ok(box, 'the other client sees the box');
  assert.match(b.doc.getXmlFragment(boxField(box!.id)).toString(), /Quokka minutes.*taskId="t-x"/);
  assert.equal(b.doc.getXmlFragment('default').length, 0);
  // A version of the document is kept.
  const versions = (await app.call('GET', `/pages/${pageId}/versions`, u.token)).data as { reason: string }[];
  assert.ok(versions.length >= 1);
  // Search still finds the text (saved right away).
  const found = (await app.call('GET', `/workspaces/${u.wsId}/search?q=quokka`, u.token)).data.pages as { id: string }[];
  assert.ok(found.some((p) => p.id === pageId));

  const back = await app.call('POST', `/pages/${pageId}/convert`, u.token, { kind: 'document' });
  assert.equal(back.status, 200);
  for (let i = 0; i < 25 && a.doc.getMap(BOXES_KEY).size > 0; i++) await new Promise((res) => setTimeout(res, 100));
  assert.equal(a.doc.getMap(BOXES_KEY).size, 0);
  assert.match(a.doc.getXmlFragment('default').toString(), /Quokka minutes.*taskId="t-x"/);
  assert.equal(await kindOf(pageId), 'document');
});

test('convert on a page nobody has open rewrites the stored doc; bad kinds and viewers are refused', async () => {
  const pageId = (await app.call('POST', `/sections/${sec}/pages`, u.token, { title: 'Stored', kind: 'canvas' })).data.id as string;
  const { db } = await import('../server/db.ts');
  const d = new Y.Doc();
  addBox(d, 'one', 0, 0, [para('Stored box')]);
  db.prepare('UPDATE pages SET ydoc = ? WHERE id = ?').run(Buffer.from(Y.encodeStateAsUpdate(d)), pageId);

  assert.equal((await app.call('POST', `/pages/${pageId}/convert`, u.token, { kind: 'table' })).status, 400);
  const stranger = await app.signUp('Stan Stranger');
  assert.equal((await app.call('POST', `/pages/${pageId}/convert`, stranger.token, { kind: 'document' })).status, 404);

  assert.equal((await app.call('POST', `/pages/${pageId}/convert`, u.token, { kind: 'document' })).status, 200);
  const row = db.prepare('SELECT ydoc, text, kind FROM pages WHERE id = ?').get(pageId) as { ydoc: Buffer; text: string; kind: string };
  assert.equal(row.kind, 'document');
  const after = new Y.Doc();
  Y.applyUpdate(after, new Uint8Array(row.ydoc));
  assert.equal(plain(after.getXmlFragment('default')), '|Stored box|');
  assert.equal(after.getMap(BOXES_KEY).size, 0);
  assert.match(row.text, /Stored box/);
  // Converting to the kind it already is changes nothing.
  assert.equal((await app.call('POST', `/pages/${pageId}/convert`, u.token, { kind: 'document' })).data.kind, 'document');
});

test('templates keep their kind: a canvas template is saved, listed and used as a canvas', async () => {
  const pageId = (await app.call('POST', `/sections/${sec}/pages`, u.token, { title: 'Board', kind: 'canvas' })).data.id as string;
  const task = (await app.call('POST', `/workspaces/${u.wsId}/tasks`, u.token, { title: 'Box task', pageId })).data.id as string;
  const content = {
    type: 'doc',
    content: [
      { type: 'canvasBox', attrs: { x: 0, y: 0, w: 320, z: 1 }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Left' }] }] },
      { type: 'canvasBox', attrs: { x: 360, y: 0, w: 400, z: 2 }, content: [{ type: 'taskRef', attrs: { taskId: task } }] },
    ],
  };
  const saved = await app.call('POST', `/pages/${pageId}/templates`, u.token, { name: 'Board kit', content, kind: 'canvas' });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.kind, 'canvas');
  assert.equal(saved.data.taskCount, 1);
  const doc = await app.call('POST', `/pages/${pageId}/templates`, u.token, { name: 'Doc kit', content: { type: 'doc', content: [{ type: 'paragraph' }] } });
  assert.equal(doc.data.kind, 'document');
  const listed = (await app.call('GET', `/workspaces/${u.wsId}/templates`, u.token)).data as { name: string; kind: string }[];
  assert.deepEqual(listed.map((t) => [t.name, t.kind]), [['Board kit', 'canvas'], ['Doc kit', 'document']]);

  // A canvas template must be boxes with geometry.
  const bad = await app.call('POST', `/pages/${pageId}/templates`, u.token, { name: 'Bad', content: { type: 'doc', content: [{ type: 'paragraph' }] }, kind: 'canvas' });
  assert.equal(bad.status, 400);

  const target = (await app.call('POST', `/sections/${sec}/pages`, u.token, { title: '' })).data.id as string;
  const used = await app.call('POST', `/templates/${saved.data.id}/use`, u.token, { pageId: target });
  assert.equal(used.status, 200);
  assert.equal(used.data.kind, 'canvas');
  const boxes = used.data.content.content as { type: string; attrs: Record<string, number>; content: { type: string; attrs?: { taskId: string } }[] }[];
  assert.deepEqual(boxes.map((b) => [b.type, b.attrs.x, b.attrs.w]), [['canvasBox', 0, 320], ['canvasBox', 360, 400]]);
  const newTask = boxes[1]!.content[0]!.attrs!.taskId;
  assert.ok(newTask && newTask !== task, 'the box points at a new task');
});
