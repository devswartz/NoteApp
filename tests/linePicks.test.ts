// Picked lines (src/editor/linePicksCore.ts): which line a position is on, sweeping, moving with edits, and what prints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Schema, type Node as PMNode } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { addLines, lineAt, linesBetween, mapPicks, pickBlocks, pickText, removeLines, toggleLine } from '../src/editor/linePicksCore.ts';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    heading: { group: 'block', content: 'inline*', attrs: { level: { default: 2 } } },
    text: { group: 'inline' },
    orderedList: { group: 'block', content: 'listItem+', attrs: { start: { default: 1 }, continued: { default: false } } },
    listItem: { content: 'paragraph block*' },
    taskRef: { group: 'block', atom: true, attrs: { taskId: { default: '' } } },
  },
});
const n = schema.nodes;
const p = (t: string) => n.paragraph.create(null, t ? schema.text(t) : null);
const li = (t: string) => n.listItem.create(null, [p(t)]);

/** Alpha, Bravo, "1. One 2. Two 3. Three", a task, Zulu. */
const doc = n.doc.create(null, [p('Alpha'), p('Bravo'), n.orderedList.create({ start: 1 }, [li('One'), li('Two'), li('Three')]), n.taskRef.create({ taskId: 't1' }), p('Zulu')]);

/** A position inside the text `t` (offset chars in). */
function inside(d: PMNode, t: string, offset = 1): number {
  let found = -1;
  d.descendants((node, pos) => {
    if (found < 0 && node.isTextblock && node.textContent === t) found = pos + 1 + offset;
    return found < 0;
  });
  assert.ok(found >= 0, `no "${t}"`);
  return found;
}

test('a position is on the textblock around it; an atom block is its own line', () => {
  const bravo = lineAt(doc, inside(doc, 'Bravo'))!;
  assert.equal(doc.textBetween(bravo.from, bravo.to), 'Bravo');
  assert.equal(bravo.node, false);
  const two = lineAt(doc, inside(doc, 'Two'))!;
  assert.equal(doc.textBetween(two.from, two.to), 'Two', 'the list item text, not the whole list');
  const task = doc.child(3);
  let taskPos = 0;
  doc.forEach((c, o, i) => {
    if (i === 3) taskPos = o;
  });
  assert.equal(task.type.name, 'taskRef');
  assert.deepEqual(lineAt(doc, taskPos), { from: taskPos, to: taskPos + 1, node: true });
});

test('toggling adds a line, then takes it out; several lines stay', () => {
  const a = lineAt(doc, inside(doc, 'Alpha'))!;
  const z = lineAt(doc, inside(doc, 'Zulu'))!;
  const both = toggleLine(toggleLine([], a), z);
  assert.equal(both.length, 2);
  assert.deepEqual(toggleLine(both, a), [z]);
});

test('sweeping from one line to another picks every line between', () => {
  const swept = linesBetween(doc, inside(doc, 'Bravo'), inside(doc, 'Three'));
  assert.deepEqual(swept.map((l) => doc.textBetween(l.from, l.to, ' ', ' ')), ['Bravo', 'One', 'Two', 'Three']);
  assert.equal(linesBetween(doc, inside(doc, 'Three'), inside(doc, 'Bravo')).length, 4, 'either direction');
  const picks = addLines([], swept);
  assert.equal(removeLines(picks, swept.slice(1, 3)).length, 2);
});

test('picks print as blocks in document order, with list numbers kept', () => {
  const picks = [lineAt(doc, inside(doc, 'Zulu'))!, lineAt(doc, inside(doc, 'Two'))!, lineAt(doc, inside(doc, 'Alpha'))!];
  const blocks = pickBlocks(doc, picks);
  assert.deepEqual(blocks.map((b) => b.type), ['paragraph', 'orderedList', 'paragraph']);
  assert.equal(blocks[1].attrs?.start, 2, 'the picked "Two" is still item 2');
  assert.equal(pickText(doc, picks), 'Alpha\nTwo\nZulu');
});

test('a picked task line prints as the task', () => {
  let taskPos = 0;
  doc.forEach((c, o) => c.type.name === 'taskRef' && (taskPos = o));
  assert.deepEqual(pickBlocks(doc, [lineAt(doc, taskPos)!]).map((b) => [b.type, b.attrs?.taskId]), [['taskRef', 't1']]);
});

test('picks move with edits and drop when their line is deleted', () => {
  const bravo = lineAt(doc, inside(doc, 'Bravo'))!;
  const zulu = lineAt(doc, inside(doc, 'Zulu'))!;
  let state = EditorState.create({ doc, schema });
  // Typing in Alpha shifts everything after it.
  let tr = state.tr.insertText('!!', inside(doc, 'Alpha'));
  const moved = mapPicks([bravo, zulu], tr.mapping, tr.doc);
  assert.deepEqual(moved.map((l) => tr.doc.textBetween(l.from, l.to)), ['Bravo', 'Zulu']);
  // Deleting Bravo's line drops its pick.
  state = state.apply(tr);
  const b = lineAt(state.doc, inside(state.doc, 'Bravo'))!;
  tr = state.tr.delete(b.from, b.to);
  const left = mapPicks([moved[0], moved[1]], tr.mapping, tr.doc);
  assert.deepEqual(left.map((l) => tr.doc.textBetween(l.from, l.to)), ['Zulu']);
  // An empty line prints nothing.
  const empty = n.doc.create(null, [p(''), p('x')]);
  assert.deepEqual(pickBlocks(empty, [lineAt(empty, 1)!]), []);
  assert.ok(TextSelection);
});
