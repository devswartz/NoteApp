// listDropTransaction (src/editor/listDrop.ts): a dragged list item keeps its list's type and attributes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Schema, type Node as PMNode } from '@tiptap/pm/model';
import { EditorState, NodeSelection } from '@tiptap/pm/state';
import { listDropTransaction } from '../src/editor/listDrop.ts';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*' },
    text: {},
    bulletList: { group: 'block', content: 'listItem+' },
    orderedList: { group: 'block', content: 'listItem+', attrs: { start: { default: 1 }, paren: { default: false }, continued: { default: false } } },
    listItem: { content: 'paragraph block*' },
  },
});
const n = schema.nodes;
const p = (t: string) => n.paragraph.create(null, t ? schema.text(t) : null);
const li = (t: string, ...kids: PMNode[]) => n.listItem.create(null, [p(t), ...kids]);
const ol = (attrs: object, ...items: PMNode[]) => n.orderedList.create(attrs, items);

/** Select the list item whose text is `t`, drop it at the end of the paragraph `at` (after it). */
function drop(doc: PMNode, t: string, at: string) {
  let item = -1;
  let dest = -1;
  doc.descendants((node, pos) => {
    if (node.type.name === 'listItem' && node.firstChild!.textContent === t) item = pos;
    if (node.type.name === 'paragraph' && node.textContent === at) dest = pos + 1 + node.content.size; // the end of that paragraph: the drop goes after it
  });
  const state = EditorState.create({ doc, schema }).apply(EditorState.create({ doc, schema }).tr.setSelection(NodeSelection.create(doc, item)));
  const tr = listDropTransaction(state, dest);
  assert.ok(tr, 'a drop transaction');
  return tr!.doc;
}
const outline = (doc: PMNode) => {
  const out: string[] = [];
  doc.forEach((b) => (b.type.name === 'paragraph' ? out.push(b.textContent) : out.push(`${b.type.name}${b.attrs.paren ? '(paren)' : ''}[${b.attrs.start ?? ''}]: ${b.content.content.map((i) => i.firstChild!.textContent).join(',')}`)));
  return out;
};

test('a numbered item dropped among paragraphs is a new ordered list of the same style, starting at 1, with its sub-list', () => {
  const doc = n.doc.create(null, [ol({ start: 3, paren: true }, li('Three', ol({ start: 1 }, li('child'))), li('Four')), p('Para'), p('Tail')]);
  const after = drop(doc, 'Three', 'Para');
  assert.deepEqual(outline(after), ['orderedList(paren)[3]: Four', 'Para', 'orderedList(paren)[1]: Three', 'Tail']);
  assert.equal(after.child(2).firstChild!.childCount, 2, 'its child list went with it');
});

test('a bullet item dropped among paragraphs stays a bullet', () => {
  const doc = n.doc.create(null, [n.bulletList.create(null, [li('a'), li('b')]), p('Para'), p('Tail')]);
  const after = drop(doc, 'b', 'Tail');
  assert.ok(after.child(after.childCount - 1).type === n.bulletList || after.child(after.childCount - 2).type === n.bulletList);
  assert.ok(!outline(after).some((l) => l.startsWith('orderedList')));
});
