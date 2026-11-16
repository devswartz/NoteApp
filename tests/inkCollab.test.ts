// Ink through the real collab server: strokes sync live between clients and are saved; the server
// drops ink entries that can't be strokes (wrong type, oversized) from a live edit.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Y from 'yjs';
import { startTestApp, type TestApp, type TestUser } from './helpers/app.ts';
import { collabClient, synced, waitFor, type CollabClient } from './helpers/collab.ts';
import { INK_KEY, MAX_STROKE_BYTES, pageInk } from '../shared/pageDoc.ts';
import { FLAG, TOOL, initInk, type InkEngine } from '../src/ink/engine.ts';
import { commitErase, commitStroke } from '../src/ink/strokes.ts';

let app: TestApp;
let ink: InkEngine;
const open: CollabClient[] = [];
before(async () => {
  app = await startTestApp();
  ink = await initInk(readFileSync(new URL('../src/ink/generated/nv_ink_bg.wasm', import.meta.url)));
});
after(async () => {
  for (const c of open) c.destroy();
  await app.close();
});

const client = (pageId: string, u: TestUser) => {
  const c = collabClient(app, pageId, u.token, { id: u.user.id, name: u.user.name, color: u.user.color });
  open.push(c);
  return c;
};

async function page(owner: TestUser) {
  const nb = await app.call('POST', `/workspaces/${owner.wsId}/notebooks`, owner.token, { name: 'Ink' });
  const sec = await app.call('POST', `/notebooks/${nb.data.id}/sections`, owner.token, { name: 'S' });
  const pg = await app.call('POST', `/sections/${sec.data.id}/pages`, owner.token, { title: 'Handwriting' });
  return pg.data.id as string;
}

const stroke = (x: number) => ink.encode({ tool: TOOL.pen, color: 0x1f2328ff, width: 2, z: 'a0', flags: FLAG.pressure }, [x, 10, 0.5, 1.5, 0, 0, x + 40, 30, 0.7, 1.5, 0, 20]);

test('a stroke drawn on one client appears on another, an erase too, and both are saved', async () => {
  const [ann, ben] = await Promise.all([app.signUp('Ann'), app.signUp('Ben')]);
  await app.call('POST', `/workspaces/${ann.wsId}/members`, ann.token, { email: ben.user.email, role: 'member' });
  const pageId = await page(ann);
  const a = client(pageId, ann);
  const b = client(pageId, ben);
  await Promise.all([synced(a), synced(b)]);

  const id = commitStroke(a.doc, stroke(5));
  await waitFor(() => pageInk(b.doc).some((s) => s.id === id), 3000, 'B to receive the stroke');
  assert.ok(ink.valid(pageInk(b.doc)[0]!.data));

  // B cuts it with the partial eraser: A sees the stroke replaced by its pieces.
  const pieces = ink.erase(pageInk(b.doc)[0]!.data, [25, 0, 25, 40], 3)!;
  assert.equal(pieces.length, 2);
  commitErase(b.doc, [id], pieces);
  await waitFor(() => pageInk(a.doc).length === 2 && !pageInk(a.doc).some((s) => s.id === id), 3000, 'A to see the erase');

  // Saved: a fresh client loads the two pieces.
  await new Promise((r) => setTimeout(r, 1300));
  const c = client(pageId, ann);
  await synced(c);
  assert.equal(pageInk(c.doc).length, 2);
});

test('the server drops ink entries that are not stroke blobs from a live edit, and keeps real strokes', async () => {
  const ann = await app.signUp('Cat');
  const pageId = await page(ann);
  const a = client(pageId, ann);
  const watcher = client(pageId, ann);
  await Promise.all([synced(a), synced(watcher)]);
  const map = a.doc.getMap<unknown>(INK_KEY);
  a.doc.transact(() => {
    map.set('text', 'not a stroke');
    map.set('huge', new Uint8Array(MAX_STROKE_BYTES + 1));
    map.set('nested', new Y.Map());
    map.set('good', stroke(0));
  });
  await waitFor(() => !map.has('text') && !map.has('huge') && !map.has('nested'), 3000, 'the bad entries to be removed');
  assert.ok(map.get('good') instanceof Uint8Array);
  await waitFor(() => watcher.doc.getMap(INK_KEY).has('good'), 3000, 'the good stroke to reach others');
  assert.deepEqual([...watcher.doc.getMap(INK_KEY).keys()], ['good']);
});
