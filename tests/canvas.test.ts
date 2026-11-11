// Canvas pages (docs/PLAN_CANVAS.md), phase 1: storage and server. A canvas keeps its
// text boxes in `box:<id>` fragments with geometry in the `boxes` map; everything that
// reads a page (search text, tasks, mentions, links, export, sanitising) sees every box.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { boxField, boxGeoms, observePageContent, pageFragments, readingOrder, BOXES_KEY } from '../shared/pageDoc.ts';
import { startTestApp, type TestApp } from './helpers/app.ts';
import { collabClient, synced, type CollabClient } from './helpers/collab.ts';

let app: TestApp;
const open: CollabClient[] = [];
before(async () => {
  app = await startTestApp();
});
after(async () => {
  for (const c of open) c.destroy();
  await app.close();
});

function addBox(doc: Y.Doc, id: string, geo: { x: number; y: number; w?: number }, blocks: (Y.XmlElement | Y.XmlText)[]) {
  doc.transact(() => {
    const g = new Y.Map<number>();
    doc.getMap(BOXES_KEY).set(id, g);
    g.set('x', geo.x);
    g.set('y', geo.y);
    g.set('w', geo.w ?? 300);
    g.set('z', 0);
    doc.getXmlFragment(boxField(id)).insert(0, blocks);
  });
}
const para = (text: string, ...inline: Y.XmlElement[]) => {
  const p = new Y.XmlElement('paragraph');
  p.insert(0, [new Y.XmlText(text), ...inline]);
  return p;
};
const el = (name: string, attrs: Record<string, string>) => {
  const e = new Y.XmlElement(name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};

test('reading order is top to bottom, then left to right', () => {
  const order = readingOrder([
    { id: 'c', x: 0, y: 300 },
    { id: 'b', x: 500, y: 0 },
    { id: 'a', x: 0, y: 0 },
  ]);
  assert.deepEqual(order.map((b) => b.id), ['a', 'b', 'c']);
});

test('pageFragments: default first, then boxes in reading order; broken geometry is defaulted', () => {
  const doc = new Y.Doc();
  addBox(doc, 'low', { x: 0, y: 400 }, [para('Low')]);
  addBox(doc, 'high', { x: 0, y: 10 }, [para('High')]);
  doc.getMap(BOXES_KEY).set('odd', { x: 'nope' }); // plain object, bad x: defaults to 0
  const frags = pageFragments(doc);
  assert.equal(frags.length, 4);
  assert.equal(frags[0], doc.getXmlFragment('default'));
  assert.deepEqual(frags.slice(1).map((f) => f.toString().replace(/<[^>]+>/g, '')), ['', 'High', 'Low']);
  assert.deepEqual(boxGeoms(doc).find((b) => b.id === 'odd'), { id: 'odd', x: 0, y: 0, w: 400, z: 0 });
});

test('observePageContent sees edits in boxes created after it started, but not the boxes map', () => {
  const doc = new Y.Doc();
  const seen: string[] = [];
  const stop = observePageContent(doc, (events) => seen.push(events.map((e) => e.target.constructor.name).join(',')));
  addBox(doc, 'b1', { x: 0, y: 0 }, [para('one')]); // map + fragment in one transaction: one call
  doc.getMap(BOXES_KEY).get('b1') instanceof Y.Map && (doc.getMap(BOXES_KEY).get('b1') as Y.Map<number>).set('x', 50); // a move only
  ((doc.getXmlFragment(boxField('b1')).get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(3, '!');
  stop();
  addBox(doc, 'b2', { x: 0, y: 0 }, [para('after stop')]);
  assert.equal(seen.length, 2);
});

test('text, tasks, mentions, links, Markdown and sanitising cover every box', async () => {
  const { extractPage } = await import('../server/collab.ts');
  const { linksInDoc } = await import('../server/links.ts');
  const { taskRefsInDoc } = await import('../server/tree.ts');
  const { toMarkdown } = await import('../server/markdown.ts');
  const { sanitizeYDoc } = await import('../server/sanitizeDoc.ts');
  const doc = new Y.Doc();
  addBox(doc, 'right', { x: 400, y: 0 }, [para('Right box ', el('pageLink', { pageId: 'pg-2' }))]);
  addBox(doc, 'left', { x: 0, y: 0 }, [para('Left box ', el('mention', { id: 'u-1', label: 'Sam' })), el('taskRef', { taskId: 't-1' })]);
  const bad = new Y.XmlElement('paragraph');
  const badText = new Y.XmlText();
  bad.insert(0, [badText]);
  addBox(doc, 'below', { x: 0, y: 300 }, [para('Below'), bad]);
  badText.insert(0, 'click me', { link: { href: 'javascript:alert(1)' } }); // links are text marks

  const page = extractPage(doc);
  assert.match(page.text, /^Left box @Sam[\s\S]*Right box[\s\S]*Below/);
  assert.deepEqual([...page.taskIds], ['t-1']);
  assert.deepEqual([...page.mentionIds], ['u-1']);
  assert.deepEqual([...linksInDoc(doc)], ['pg-2']);
  assert.deepEqual(taskRefsInDoc(doc).map((e) => e.getAttribute('taskId')), ['t-1']);

  const md = toMarkdown('Board', pageFragments(doc), (id) => (id === 't-1' ? { title: 'Ship it', done: false, due: null } : undefined));
  assert.ok(md.indexOf('Left box') < md.indexOf('Ship it') && md.indexOf('Ship it') < md.indexOf('Right box') && md.indexOf('Right box') < md.indexOf('Below'), md);

  assert.ok(sanitizeYDoc(doc) >= 1, 'the javascript: link in a box is removed');
  assert.doesNotMatch(doc.getXmlFragment(boxField('below')).toString(), /javascript:/);
});

test('every page is created as a canvas, and text typed in a box is saved and searchable', async () => {
  const u = await app.signUp('Cara Canvas');
  const tree = (await app.call('GET', `/workspaces/${u.wsId}/tree`, u.token)).data;
  const sec = tree.sections[0].id as string;
  const made = await app.call('POST', `/sections/${sec}/pages`, u.token, { title: 'Whiteboard', kind: 'canvas' });
  const plain = await app.call('POST', `/sections/${sec}/pages`, u.token, { title: 'Plain', kind: 'bogus' });
  const kinds = (await app.call('GET', `/workspaces/${u.wsId}/tree`, u.token)).data.pages as { id: string; kind: string }[];
  assert.equal(kinds.find((p) => p.id === made.data.id)?.kind, 'canvas');
  assert.equal(kinds.find((p) => p.id === plain.data.id)?.kind, 'canvas', 'any other kind asked for is ignored');

  const c = collabClient(app, made.data.id, u.token, { id: u.user.id, name: u.user.name, color: u.user.color });
  open.push(c);
  await synced(c);
  addBox(c.doc, 'b1', { x: 120, y: 80 }, [para('Quarterly zeppelin budget')]);

  // Saved on the collab server's debounce (about 1 s), then found by search.
  const found = async () => ((await app.call('GET', `/workspaces/${u.wsId}/search?q=zeppelin`, u.token)).data.pages ?? []).some((p: { id: string }) => p.id === made.data.id);
  let ok = false;
  for (let i = 0; i < 25 && !ok; i++) {
    await new Promise((r) => setTimeout(r, 200));
    ok = await found();
  }
  assert.ok(ok, 'box text to be saved and searchable');
});
