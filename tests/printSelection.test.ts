// "Print selection" (src/print/selectionContent.ts): what a text selection prints, and picking boxes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Schema, type Node as PMNode } from '@tiptap/pm/model';
import { AllSelection, NodeSelection, TextSelection } from '@tiptap/pm/state';
import { selectionBlocks, toggleId } from '../src/print/selectionContent.ts';

// The editor's node names, with just what these tests need.
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    text: { group: 'inline' },
    image: { group: 'inline', inline: true, attrs: { src: { default: '' } } },
    orderedList: { group: 'block', content: 'listItem+', attrs: { start: { default: 1 }, continued: { default: false } } },
    bulletList: { group: 'block', content: 'listItem+' },
    listItem: { content: 'paragraph block*' },
    table: { group: 'block', content: 'tableRow+' },
    tableRow: { content: 'tableCell+' },
    tableCell: { content: 'paragraph+' },
  },
  marks: { bold: {} },
});
const n = schema.nodes;
const p = (t: string, bold = false) => n.paragraph.create(null, t ? schema.text(t, bold ? [schema.marks.bold.create()] : []) : null);
const li = (t: string, ...more: PMNode[]) => n.listItem.create(null, [p(t), ...more]);
const ol = (attrs: Record<string, unknown>, ...items: PMNode[]) => n.orderedList.create(attrs, items);

/** Position just inside the text of the first textblock containing `text`, plus `offset`. */
function at(doc: PMNode, text: string, offset = 0): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.isTextblock && node.textContent.includes(text)) found = pos + 1 + node.textContent.indexOf(text) + offset;
    return true;
  });
  assert.ok(found >= 0, `no "${text}"`);
  return found;
}
const textSel = (doc: PMNode, from: number, to: number) => TextSelection.create(doc, from, to);
const texts = (blocks: unknown) => JSON.stringify(blocks).match(/"text":"[^"]*"/g)?.map((s) => s.slice(8, -1)) ?? [];

test('toggleId adds and removes a box, keeping the picking order', () => {
  assert.deepEqual(toggleId([], 'a'), ['a']);
  assert.deepEqual(toggleId(['a'], 'b'), ['a', 'b']);
  assert.deepEqual(toggleId(['a', 'b', 'c'], 'b'), ['a', 'c']);
});

test('an empty selection prints nothing', () => {
  const doc = n.doc.create(null, [p('Hello')]);
  assert.deepEqual(selectionBlocks(textSel(doc, 2, 2)), []);
});

test('a selection inside a paragraph prints just that text, formatting kept', () => {
  const doc = n.doc.create(null, [p('Alpha one'), p('Bravo two', true), p('Charlie')]);
  const blocks = selectionBlocks(textSel(doc, at(doc, 'two'), at(doc, 'two', 3)));
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.type, 'paragraph');
  assert.deepEqual(texts(blocks), ['two']);
  assert.equal(blocks[0]!.content![0]!.marks?.[0]?.type, 'bold');
});

test('a selection across paragraphs is cut at both ends', () => {
  const doc = n.doc.create(null, [p('Alpha one'), p('Bravo two'), p('Charlie three'), p('Delta')]);
  const blocks = selectionBlocks(textSel(doc, at(doc, 'one'), at(doc, 'Charlie', 7)));
  assert.deepEqual(blocks.map((b) => b.type), ['paragraph', 'paragraph', 'paragraph']);
  assert.deepEqual(texts(blocks), ['one', 'Bravo two', 'Charlie']);
});

test('a numbered list cut at its 3rd item keeps counting from 3', () => {
  const doc = n.doc.create(null, [p('Intro'), ol({ start: 1 }, li('First'), li('Second'), li('Third'), li('Fourth'))]);
  const blocks = selectionBlocks(textSel(doc, at(doc, 'Third'), at(doc, 'Fourth', 6)));
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.type, 'orderedList');
  assert.equal(blocks[0]!.attrs!.start, 3);
  assert.deepEqual(texts(blocks), ['Third', 'Fourth']);
});

test('a list that carried on from an earlier one keeps its numbers too', () => {
  // 1. A  2. B  (paragraph)  3. C  4. D (continued)
  const doc = n.doc.create(null, [ol({ start: 1 }, li('A'), li('B')), p('Between'), ol({ start: 1, continued: true }, li('C'), li('D'))]);
  const whole = selectionBlocks(textSel(doc, at(doc, 'Between'), at(doc, 'D', 1)));
  assert.deepEqual(whole.map((b) => b.type), ['paragraph', 'orderedList']);
  assert.equal(whole[1]!.attrs!.start, 3);
  assert.equal(whole[1]!.attrs!.continued, false);
  const cut = selectionBlocks(textSel(doc, at(doc, 'D'), at(doc, 'D', 1)));
  assert.equal(cut[0]!.type, 'orderedList'); // text inside one item still prints as that numbered item
  assert.equal(cut[0]!.attrs!.start, 4);
});

test('a nested numbered list cut inside keeps both levels’ numbers', () => {
  const doc = n.doc.create(null, [ol({ start: 5 }, li('Five'), li('Six', ol({ start: 1 }, li('Six-a'), li('Six-b'), li('Six-c'))))]);
  const blocks = selectionBlocks(textSel(doc, at(doc, 'Six-b'), at(doc, 'Six-c', 5)));
  assert.equal(blocks[0]!.attrs!.start, 6); // the outer list, cut at its 2nd item
  const inner = blocks[0]!.content![0]!.content!.find((c) => c.type === 'orderedList')!;
  assert.equal(inner.attrs!.start, 2);
  assert.deepEqual(texts(blocks), ['Six-b', 'Six-c']);
});

test('bullet lists and tables come through as their own blocks', () => {
  const table = n.table.create(null, [n.tableRow.create(null, [n.tableCell.create(null, p('Cell 1')), n.tableCell.create(null, p('Cell 2'))])]);
  const doc = n.doc.create(null, [n.bulletList.create(null, [li('Dot')]), table, p('After')]);
  const blocks = selectionBlocks(new AllSelection(doc));
  assert.deepEqual(blocks.map((b) => b.type), ['bulletList', 'table', 'paragraph']);
  assert.deepEqual(texts(blocks), ['Dot', 'Cell 1', 'Cell 2', 'After']);
});

test('a selected image prints in a paragraph of its own', () => {
  const doc = n.doc.create(null, [n.paragraph.create(null, [schema.text('Pic: '), n.image.create({ src: 'x.png' })])]);
  const blocks = selectionBlocks(NodeSelection.create(doc, at(doc, 'Pic', 5)));
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.type, 'paragraph');
  assert.equal(blocks[0]!.content![0]!.type, 'image');
});
