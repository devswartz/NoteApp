// The bridge to the iPad's native pen layer (src/ink/nativeInk.ts), run against a fake plugin like
// tests/mobile.test.ts: strokes cross once each, every change to the ink map reaches native, native
// changes are written with the web pen's code (one undo step each) and acknowledged, and a pinch's
// view is applied before native is told. Plus the debug page filler (src/ink/testFill.ts).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Y from 'yjs';
import { BOXES_KEY, INK_KEY, boxGeoms, newBoxMap } from '../shared/pageDoc.ts';
import { initInk, type InkEngine } from '../src/ink/engine.ts';
import { NativeInkSession, fromBase64, nativeInkPlugin, toBase64, type NativeInkEvents, type NativeInkLayout, type NativeInkPlugin, type NativeInkTool, type NativeView } from '../src/ink/nativeInk.ts';
import { INK_ORIGIN, commitStroke, zAfter } from '../src/ink/strokes.ts';
import { canvasUndoManager } from '../src/editor/canvasUndo.ts';
import { fillTestPage, type TestBox } from '../src/ink/testFill.ts';

/** Boxes as writeBoxes stores their geometry (the text needs the editor schema; not checked here). */
const addBoxes = (doc: Y.Doc) => (boxes: TestBox[]) =>
  doc.transact(() => boxes.forEach((b, i) => doc.getMap<unknown>(BOXES_KEY).set(`t${boxGeoms(doc).length}-${i}`, newBoxMap({ x: b.x, y: b.y, w: b.w, z: i + 1 }))));

const tick = () => new Promise((r) => setTimeout(r, 0));
const blob = (n: number) => new Uint8Array([1, n, n, 200]);

const LAYOUT: NativeInkLayout = { scroller: { x: 0, y: 48, w: 1000, h: 700 }, surface: { x: 40, y: 14, w: 1200, h: 2000 }, zoom: 1, exclusions: [] };
const TOOL_STATE: NativeInkTool = { tool: 'pen', color: 0x1f2328ff, width: 2.5, fingerDrawing: false, penTool: 'pen', pencilSwitches: true, eraserRadius: 8, dark: false };

/** A fake NoteAppInk plugin: records calls, lets the test fire native events. */
function fakePlugin(opts: { attached?: boolean; available?: boolean } = {}) {
  const calls: [string, unknown][] = [];
  const handlers = new Map<string, (e: unknown) => void>();
  let removed = 0;
  const plugin: NativeInkPlugin = {
    available: async () => ({ available: opts.available ?? true }),
    attach: async (l) => (calls.push(['attach', l]), { attached: opts.attached ?? true }),
    layout: async (l) => (calls.push(['layout', l]), { attached: true }),
    detach: async () => void calls.push(['detach', null]),
    setTool: async (t) => void calls.push(['setTool', t]),
    setStrokes: async (o) => void calls.push(['setStrokes', o]),
    updateStrokes: async (o) => void calls.push(['updateStrokes', o]),
    viewApplied: async (o) => void calls.push(['viewApplied', o]),
    setRenderer: async (o) => (calls.push(['setRenderer', o]), { renderer: o.renderer }),
    addListener: (k, fn) => {
      handlers.set(k, fn as (e: unknown) => void);
      return { remove: () => void removed++ };
    },
  };
  const fire = <K extends keyof NativeInkEvents>(k: K, e: NativeInkEvents[K]) => handlers.get(k)!(e);
  const named = (n: string) => calls.filter((c) => c[0] === n).map((c) => c[1]);
  return { plugin, calls, fire, named, removedCount: () => removed };
}

test('base64 round-trips blobs of any size', () => {
  for (const n of [0, 1, 2, 3, 100, 70_000]) {
    const b = new Uint8Array(n).map((_, i) => (i * 7) & 255);
    assert.deepEqual(fromBase64(toBase64(b)), b);
  }
});

test('start attaches, sends the tool and every stroke once; stop detaches', async () => {
  const doc = new Y.Doc();
  const ink = doc.getMap<unknown>(INK_KEY);
  ink.set('a', blob(1));
  ink.set('b', blob(2));
  ink.set('junk', 'not a blob');
  const f = fakePlugin();
  const s = new NativeInkSession(f.plugin, doc);
  assert.equal(await s.start(LAYOUT, TOOL_STATE), true);
  assert.deepEqual(f.named('attach'), [LAYOUT]);
  assert.deepEqual(f.named('setTool'), [TOOL_STATE]);
  const [sent] = f.named('setStrokes') as { strokes: { id: string; data: string }[] }[];
  assert.deepEqual(sent!.strokes.map((x) => x.id).sort(), ['a', 'b']);
  assert.deepEqual(fromBase64(sent!.strokes.find((x) => x.id === 'b')!.data), blob(2));
  await s.stop();
  assert.equal(f.named('detach').length, 1);
  assert.equal(f.removedCount(), 8, 'every listener removed');
  // After stop, changes no longer cross.
  ink.set('c', blob(3));
  assert.equal(f.named('updateStrokes').length, 0);
});

test('when native cannot attach, the session does nothing (the web pen stays)', async () => {
  const doc = new Y.Doc();
  const f = fakePlugin({ attached: false });
  const statuses: string[] = [];
  const s = new NativeInkSession(f.plugin, doc, { onStatus: (x) => statuses.push(x) });
  assert.equal(await s.start(LAYOUT, TOOL_STATE, [0, 0, 0]), false);
  assert.equal(f.named('attach').length, 3, 'tried each time');
  assert.match(statuses.at(-1)!, /web pen: native layer didn't attach/);
  assert.equal(f.named('setStrokes').length, 0);
  doc.getMap(INK_KEY).set('x', blob(1));
  assert.equal(f.named('updateStrokes').length, 0);
});

test("attach is retried until WebKit has made the page's scroll view, measuring the page each time", async () => {
  const doc = new Y.Doc();
  const f = fakePlugin();
  let tries = 0;
  f.plugin.attach = async (l) => (f.calls.push(['attach', l]), ++tries < 3 ? { attached: false, detail: 'wanted 0,48 1000x700; scroll views: 0,0 1194x834' } : { attached: true });
  const statuses: string[] = [];
  let measured = 0;
  const s = new NativeInkSession(f.plugin, doc, { onStatus: (x) => statuses.push(x) });
  const ok = await s.start(() => (measured++, { ...LAYOUT, zoom: measured }), TOOL_STATE, [0, 1, 1, 1]);
  assert.equal(ok, true);
  assert.equal(tries, 3);
  assert.deepEqual((f.named('attach') as NativeInkLayout[]).map((l) => l.zoom), [1, 2, 3], 'measured again for each try');
  assert.equal(statuses.at(-1), 'native layer attached');
  assert.equal(f.named('setStrokes').length, 1);
  await s.stop();
});

test('a failed attach reports what native saw', async () => {
  const doc = new Y.Doc();
  const f = fakePlugin();
  f.plugin.attach = async () => ({ attached: false, detail: 'wanted 0,48 1000x700; scroll views: 0,0 1194x834' });
  const statuses: string[] = [];
  const s = new NativeInkSession(f.plugin, doc, { onStatus: (x) => statuses.push(x) });
  assert.equal(await s.start(LAYOUT, TOOL_STATE, [0]), false);
  assert.equal(statuses.at(-1), "web pen: native layer didn't attach (wanted 0,48 1000x700; scroll views: 0,0 1194x834)");
});

test('remote strokes, deletions and undo reach native as updates', async () => {
  const doc = new Y.Doc();
  const f = fakePlugin();
  const s = new NativeInkSession(f.plugin, doc);
  await s.start(LAYOUT, TOOL_STATE);
  // A collaborator's stroke arrives as a Yjs update.
  const remote = new Y.Doc();
  remote.getMap(INK_KEY).set('r1', blob(9));
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote));
  let [u] = f.named('updateStrokes') as { added: { id: string; data: string }[]; removed: string[]; ack?: string }[];
  assert.deepEqual(u!.added.map((a) => a.id), ['r1']);
  assert.deepEqual(fromBase64(u!.added[0]!.data), blob(9));
  assert.equal(u!.ack, undefined);
  // Our own stroke undone: native hears it's gone.
  const um = canvasUndoManager(doc, 0);
  const id = commitStroke(doc, blob(4));
  um.undo();
  const updates = f.named('updateStrokes') as { removed: string[] }[];
  assert.deepEqual(updates.at(-1)!.removed, [id]);
  await s.stop();
});

test('a native stroke is written like the web pen, as its own undo step, and acknowledged with its token', async () => {
  const doc = new Y.Doc();
  const f = fakePlugin();
  let writes = 0;
  const um = canvasUndoManager(doc, 60_000);
  // As InkSurface does: close the undo capture around each write.
  const s = new NativeInkSession(f.plugin, doc, { onWrite: () => (writes++, um.stopCapturing()) });
  await s.start(LAYOUT, TOOL_STATE);
  const origins: unknown[] = [];
  doc.on('afterTransaction', (tr: Y.Transaction) => origins.push(tr.origin));

  f.fire('stroke', { token: 's1', data: toBase64(blob(5)) });
  const ink = doc.getMap<unknown>(INK_KEY);
  assert.equal(ink.size, 1);
  const [id] = [...ink.keys()];
  assert.deepEqual(ink.get(id!), blob(5));
  assert.equal(origins.at(-1), INK_ORIGIN, 'the same origin as the web pen');
  assert.equal(writes, 2, 'the undo capture is closed before and after');
  const u = (f.named('updateStrokes') as { added: { id: string }[]; ack?: string }[]).at(-1)!;
  assert.deepEqual(u.added.map((a) => a.id), [id]);
  assert.equal(u.ack, 's1', 'the update that adds it carries the token: native swaps its drawing in the same frame');

  f.fire('stroke', { token: 's2', data: toBase64(blob(6)) });
  um.undo();
  assert.equal(ink.size, 1, 'one stroke per undo step');
  await s.stop();
});

test("with the web drawing finished ink, a stroke's token goes back only once it is painted", async () => {
  const doc = new Y.Doc();
  const f = fakePlugin();
  let paint!: () => void;
  const s = new NativeInkSession(f.plugin, doc, { ackAfterPaint: () => new Promise<void>((r) => (paint = r)) });
  await s.start(LAYOUT, TOOL_STATE);
  f.fire('stroke', { token: 's1', data: toBase64(blob(5)) });
  const updates = () => f.named('updateStrokes') as { added: unknown[]; ack?: string }[];
  assert.equal(updates().length, 1, 'the stroke reaches native as a page change');
  assert.equal(updates()[0]!.ack, undefined, 'but not acknowledged yet: native keeps holding it');
  paint();
  await tick();
  await tick();
  assert.deepEqual(updates().at(-1), { added: [], removed: [], ack: 's1' });
  await s.stop();
});

test('a native erase is one transaction and acknowledged, even when it changes nothing', async () => {
  const doc = new Y.Doc();
  const ink = doc.getMap<unknown>(INK_KEY);
  ink.set('a', blob(1));
  ink.set('b', blob(2));
  const f = fakePlugin();
  const s = new NativeInkSession(f.plugin, doc);
  await s.start(LAYOUT, TOOL_STATE);
  let txns = 0;
  doc.on('afterTransaction', () => txns++);
  f.fire('erase', { token: 'e1', removed: ['a', 'b'], added: [toBase64(blob(7))] });
  assert.equal(txns, 1);
  assert.deepEqual([...ink.values()], [blob(7)]);
  let u = (f.named('updateStrokes') as { added: unknown[]; removed: string[]; ack?: string }[]).at(-1)!;
  assert.deepEqual(u.removed.sort(), ['a', 'b']);
  assert.equal(u.added.length, 1);
  assert.equal(u.ack, 'e1');
  // Someone else already deleted what this erase removed: nothing changes, the token still goes back.
  f.fire('erase', { token: 'e2', removed: ['gone'], added: [] });
  u = (f.named('updateStrokes') as { added: unknown[]; removed: string[]; ack?: string }[]).at(-1)!;
  assert.deepEqual(u, { added: [], removed: [], ack: 'e2' });
  await s.stop();
});

test('a pinch view is applied before native is told; scroll reports are not', async () => {
  const doc = new Y.Doc();
  const f = fakePlugin();
  const order: string[] = [];
  const s = new NativeInkSession(f.plugin, doc, {
    onView: async (v: NativeView) => {
      await tick();
      order.push(`apply ${v.zoom}`);
    },
  });
  const origViewApplied = f.plugin.viewApplied;
  f.plugin.viewApplied = async (o) => {
    order.push(`applied ${o.zoom}`);
    return origViewApplied(o);
  };
  await s.start(LAYOUT, TOOL_STATE);
  f.fire('view', { zoom: 2, x: 100, y: 400, final: true });
  await tick();
  await tick();
  assert.deepEqual(order, ['apply 2', 'applied 2']);
  f.fire('view', { zoom: 2, x: 120, y: 500, final: false });
  await tick();
  await tick();
  assert.equal(f.named('viewApplied').length, 1, 'a scroll report needs no answer');
  await s.stop();
});

test('Pencil double-tap, two-finger tap (undo) and three-finger tap (redo) reach the page; tool and layout go to native', async () => {
  const doc = new Y.Doc();
  const f = fakePlugin();
  const got: string[] = [];
  const s = new NativeInkSession(f.plugin, doc, { onTool: (t, enter) => got.push(`tool ${t}${enter ? ' (enter draw)' : ''}`), onUndo: () => got.push('undo'), onRedo: () => got.push('redo'), onDetached: () => got.push('detached') });
  await s.start(LAYOUT, TOOL_STATE);
  f.fire('tool', { tool: 'eraser' });
  f.fire('tool', { tool: 'pen', enterDraw: true });
  f.fire('undo', {});
  f.fire('redo', {});
  f.fire('detached', {});
  assert.deepEqual(got, ['tool eraser', 'tool pen (enter draw)', 'undo', 'redo', 'detached']);
  s.setTool({ ...TOOL_STATE, tool: 'highlighter' });
  s.layout({ ...LAYOUT, zoom: 1.5 });
  await tick();
  assert.equal((f.named('setTool').at(-1) as NativeInkTool).tool, 'highlighter');
  assert.equal((f.named('layout').at(-1) as NativeInkLayout).zoom, 1.5);
  await s.stop();
});

test('the plugin is used only where native says it is available (iPad)', async () => {
  assert.equal(await nativeInkPlugin(async () => ({ plugin: fakePlugin({ available: false }).plugin })), null);
  assert.ok(await nativeInkPlugin(async () => ({ plugin: fakePlugin().plugin })));
  assert.equal(await nativeInkPlugin(async () => null), null);
  assert.equal(await nativeInkPlugin(async () => Promise.reject(new Error('no plugin'))), null);
});

test('a Capacitor-style plugin (a Proxy that answers `then` too) is found, not hung on', async () => {
  // Like registerPlugin(): every property is a method that calls native; `then` included, whose
  // native call never answers. Resolving a promise with this object hangs forever.
  const fake = fakePlugin().plugin as unknown as Record<string, unknown>;
  const proxy = new Proxy({}, { get: (_t, k) => (k === 'then' ? () => new Promise(() => {}) : fake[k as string]) }) as NativeInkPlugin;
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('hung on the plugin')), 1000));
  const p = await Promise.race([nativeInkPlugin(async () => ({ plugin: proxy })), timeout]);
  assert.ok(p, 'found');
  assert.equal(typeof (p as { then?: unknown }).then, 'undefined', 'what callers get is not thenable');
  assert.deepEqual(await (p as NativeInkPlugin).available(), { available: true });
});

test('z keys: the native layer makes the same ones (pinned for NvInkTests.testZKeysMatchTheWeb)', () => {
  assert.equal(zAfter(null), 'a0');
  assert.equal(zAfter('a0'), 'a1');
  assert.equal(zAfter('a9'), 'aA');
  assert.equal(zAfter('az'), 'b10');
  assert.equal(zAfter('b1z'), 'b20');
  assert.equal(zAfter('weird'), 'weirdV');
});

let engine: InkEngine;
before(async () => {
  engine = await initInk(readFileSync(new URL('../src/ink/generated/nv_ink_bg.wasm', import.meta.url)));
});

test('the debug filler makes a heavy page: 50 boxes and thousands of valid strokes, the same every time', () => {
  const doc = new Y.Doc();
  const r = fillTestPage(doc, engine, addBoxes(doc), { strokes: 3000 });
  assert.deepEqual(r, { boxes: 50, strokes: 3000 });
  assert.equal(boxGeoms(doc).length, 50);
  const ink = doc.getMap<unknown>(INK_KEY);
  assert.equal(ink.size, 3000);
  let maxY = 0;
  for (const v of ink.values()) {
    const info = engine.info(v as Uint8Array)!;
    assert.ok(info && info.count > 1);
    maxY = Math.max(maxY, info.bounds.maxY);
  }
  assert.ok(maxY > 3000, 'covers the page as far down as the boxes');
  // Again: no more boxes (already 50), strokes on top.
  assert.deepEqual(fillTestPage(doc, engine, addBoxes(doc), { strokes: 10 }), { boxes: 0, strokes: 10 });
  const doc2 = new Y.Doc();
  fillTestPage(doc2, engine, addBoxes(doc2), { strokes: 50, boxes: 0 });
  const doc3 = new Y.Doc();
  fillTestPage(doc3, engine, addBoxes(doc3), { strokes: 50, boxes: 0 });
  const pts = (d: Y.Doc) => [...d.getMap<unknown>(INK_KEY).values()].map((v) => [...engine.points(v as Uint8Array)!].slice(0, 2).join(',')).sort();
  assert.deepEqual(pts(doc2), pts(doc3), 'deterministic');
});
