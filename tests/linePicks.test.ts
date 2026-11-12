// Picked text (src/editor/linePicksCore.ts): exact ranges, merging, moving with edits, and what prints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Schema, type Node as PMNode } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { addRange, mapRanges, pickBlocks, pickText, rangeOf, touches } from '../src/editor/linePicksCore.ts';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    text: { group: 'inline' },
    orderedList: { group: 'block', content: 'listItem+', attrs: { start: { default: 1 }, continued: { default: false } } },
    listItem: { content: 'paragraph block*' },
  },
  marks: { bold: {} },
});
const n = schema.nodes;
const p = (t: string, bold = false) => n.paragraph.create(null, t ? schema.text(t, bold ? [schema.marks.bold.create()] : []) : null);
const li = (t: string) => n.listItem.create(null, [p(t)]);

// "The quick brown fox" / "jumps over" / "1. First step 2. Second step 3. Third step" / "Last line"
const doc = n.doc.create(null, [p('The quick brown fox'), p('jumps over'), n.orderedList.create({ start: 1 }, [li('First step'), li('Second step'), li('Third step')]), p('Last line')]);

/** The position of `word` (first occurrence) in the doc: [from, to]. */
function at(d: PMNode, word: string): [number, number] {
  let out: [number, number] | null = null;
  d.descendants((node, pos) => {
    if (out || !node.isText) return;
    const i = node.text!.indexOf(word);
    if (i >= 0) out = [pos + i, pos + i + word.length];
  });
  assert.ok(out, `no "${word}"`);
  return out!;
}

test('a range is exactly what was selected, whichever way it was dragged', () => {
  const [from, to] = at(doc, 'quick brown');
  assert.deepEqual(rangeOf(doc, from, to), { from, to });
  assert.deepEqual(rangeOf(doc, to, from), { from, to }, 'right to left');
  assert.equal(rangeOf(doc, from, from), null, 'a caret picks nothing');
});

test('a triple-click, which selects up to the start of the next paragraph, picks just the line', () => {
  const [lineStart] = at(doc, 'The quick');
  const [nextStart] = at(doc, 'jumps over');
  const r = rangeOf(doc, lineStart, nextStart)!;
  assert.equal(doc.textBetween(r.from, r.to), 'The quick brown fox');
  // A drag that starts at the very end of a line starts on the next one.
  const [, endOfFirst] = at(doc, 'brown fox');
  const [, endOfSecond] = at(doc, 'jumps');
  const s = rangeOf(doc, endOfFirst, endOfSecond)!;
  assert.equal(doc.textBetween(s.from, s.to), 'jumps');
});

test('whitespace alone picks nothing', () => {
  const d = n.doc.create(null, [p('a   b'), p('')]);
  assert.equal(rangeOf(d, 2, 5), null, 'the spaces between two words');
});

test('overlapping or touching ranges become one; separate ones stay, in order', () => {
  assert.deepEqual(addRange([{ from: 10, to: 20 }], { from: 15, to: 30 }), [{ from: 10, to: 30 }]);
  assert.deepEqual(addRange([{ from: 10, to: 20 }], { from: 20, to: 25 }), [{ from: 10, to: 25 }], 'touching');
  assert.deepEqual(addRange([{ from: 10, to: 20 }, { from: 40, to: 50 }], { from: 25, to: 30 }), [{ from: 10, to: 20 }, { from: 25, to: 30 }, { from: 40, to: 50 }]);
  assert.deepEqual(addRange([{ from: 10, to: 20 }, { from: 30, to: 40 }], { from: 15, to: 35 }), [{ from: 10, to: 40 }], 'one range bridging two');
  assert.ok(touches([{ from: 10, to: 20 }], 20) && !touches([{ from: 10, to: 20 }], 21));
});

test('picks move with the text through edits: before shifts, inside grows, at the edges stays out, deleted drops', () => {
  const [from, to] = at(doc, 'quick');
  const pick = [{ from, to }];
  const state = EditorState.create({ doc, schema });
  const text = (d: PMNode, r: { from: number; to: number }) => d.textBetween(r.from, r.to);

  // Typing before it shifts it; typing inside makes it longer; typing at either edge stays outside.
  let tr = state.tr.insertText('Well, ', at(doc, 'The')[0]);
  assert.equal(text(tr.doc, mapRanges(pick, tr.mapping, tr.doc)[0]), 'quick');
  tr = state.tr.insertText('XX', from + 2);
  assert.equal(text(tr.doc, mapRanges(pick, tr.mapping, tr.doc)[0]), 'quXXick');
  tr = state.tr.insertText('<<', from);
  assert.equal(text(tr.doc, mapRanges(pick, tr.mapping, tr.doc)[0]), 'quick');
  tr = state.tr.insertText('>>', to);
  assert.equal(text(tr.doc, mapRanges(pick, tr.mapping, tr.doc)[0]), 'quick');
  // Deleting part of it shrinks it; deleting all of it drops it.
  tr = state.tr.delete(from, from + 2);
  assert.equal(text(tr.doc, mapRanges(pick, tr.mapping, tr.doc)[0]), 'ick');
  tr = state.tr.delete(from - 1, to + 1);
  assert.deepEqual(mapRanges(pick, tr.mapping, tr.doc), []);
});

test('picked pieces print as they are: partial lines stay partial, formatting kept, in document order', () => {
  const d = n.doc.create(null, [p('plain and '), n.paragraph.create(null, [schema.text('bold', [schema.marks.bold.create()]), schema.text(' tail')])]);
  const [a, b] = at(d, 'and');
  const [c] = at(d, 'bold');
  const e = at(d, ' tail')[1];
  const blocks = pickBlocks(d, [{ from: c, to: e }, { from: a, to: b }]);
  assert.deepEqual(blocks.map((x) => x.type), ['paragraph', 'paragraph']);
  assert.deepEqual(blocks[0].content, [{ type: 'text', text: 'and' }]);
  assert.deepEqual(blocks[1].content, [{ type: 'text', text: 'bold', marks: [{ type: 'bold' }] }, { type: 'text', text: ' tail' }], 'in order, bold kept');
});

test('a piece picked inside a numbered item keeps its number', () => {
  const [from, to] = at(doc, 'Second');
  const blocks = pickBlocks(doc, [{ from, to }]);
  assert.equal(blocks[0].type, 'orderedList');
  assert.equal(blocks[0].attrs?.start, 2, 'the picked "Second" is still item 2');
  assert.equal(pickText(doc, [{ from, to }]), 'Second');
});

test('a range across lines prints each cut at both ends; text is one range per line', () => {
  const [from] = at(doc, 'brown');
  const [, to] = at(doc, 'jumps');
  assert.deepEqual(pickBlocks(doc, [{ from, to }]).map((x) => x.content?.[0]?.text), ['brown fox', 'jumps']);
  const [lf, lt] = at(doc, 'Last');
  assert.equal(pickText(doc, [{ from: lf, to: lt }, { from, to }]), 'brown fox\njumps\nLast');
});
