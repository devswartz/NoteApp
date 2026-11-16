// Draw mode and the pen tools' state (src/ink/inkTool.ts): the ribbon's Draw toggle switches the
// canvas between typing and drawing, remembered per device, and pen tools only apply in draw mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ls = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => ls.get(k) ?? null,
  setItem: (k: string, v: string) => void ls.set(k, v),
  removeItem: (k: string) => void ls.delete(k),
};
// A device that was left in draw mode with the highlighter (load reads this at import).
ls.set('noteapp.ink.tool', JSON.stringify({ drawMode: true, penTool: 'highlighter', fingerDrawing: true }));
const { useInkTool, setDrawMode, setInkTool, strokeStyle, useInkAvailable } = await import('../src/ink/inkTool.ts');

test('the mode and the pen tool are remembered on the device', () => {
  const s = useInkTool.getState();
  assert.equal(s.drawMode, true);
  assert.equal(s.tool, 'highlighter', 'draw mode opens with the last pen tool');
  assert.equal(s.fingerDrawing, true);
  assert.equal(s.pencilSwitches, true, 'the Pencil auto-switch is on by default');
});

test('the Draw toggle switches between typing and the last pen tool', () => {
  setDrawMode(false);
  assert.equal(useInkTool.getState().tool, 'select', 'type mode: no pen behaviour');
  assert.equal(strokeStyle(useInkTool.getState()), null);
  assert.equal(JSON.parse(ls.get('noteapp.ink.tool')!).drawMode, false);
  setDrawMode(true);
  assert.equal(useInkTool.getState().tool, 'highlighter');
  setInkTool({ tool: 'partialEraser' });
  setDrawMode(false);
  setDrawMode(true);
  assert.equal(useInkTool.getState().tool, 'partialEraser');
  assert.equal(JSON.parse(ls.get('noteapp.ink.tool')!).tool, undefined, 'the tool in effect is derived, not stored');
});

test('picking a pen tool in type mode never switches to drawing', () => {
  setDrawMode(false);
  setInkTool({ tool: 'pen' }); // e.g. Pencil double-tap arriving late
  assert.equal(useInkTool.getState().tool, 'select');
  assert.equal(useInkTool.getState().penTool, 'pen', 'remembered for the next time draw mode is on');
  setDrawMode(true);
  assert.equal(useInkTool.getState().tool, 'pen');
});

test('a Pencil touch in type mode turns draw mode on with the last pen tool (what the bridge does for enterDraw)', () => {
  setDrawMode(false);
  setInkTool({ drawMode: true, tool: 'eraser' });
  assert.equal(useInkTool.getState().drawMode, true);
  assert.equal(useInkTool.getState().tool, 'eraser');
  assert.equal(JSON.parse(ls.get('noteapp.ink.tool')!).drawMode, true);
});

test('ink is offered only where the page says so', () => {
  assert.equal(useInkAvailable.getState().available, false);
});
