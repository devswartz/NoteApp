// Keyboard block moves (Alt+Shift+↑/↓), src/editor/blockMove.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from '@tiptap/pm/model';
import { EditorState, NodeSelection, TextSelection, type Transaction } from '@tiptap/pm/state';
import { moveBlock } from '../src/editor/blockMove.ts';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*' },
    bulletList: { group: 'block', content: 'listItem+' },
    listItem: { content: 'paragraph block*' },
    image: { group: 'block', atom: true, attrs: { src: { default: '' } } },
    text: {},
  },
});
const p = (t: string) => schema.node('paragraph', null, t ? [schema.text(t)] : []);
const li = (t: string) => schema.node('listItem', null, [p(t)]);
const texts = (s: EditorState) => {
  const out: string[] = [];
  s.doc.forEach((n) => out.push(n.type.name === 'bulletList' ? `[${n.content.content.map((i) => i.textContent).join(',')}]` : n.type.name === 'image' ? 'IMG' : n.textContent));
  return out;
};
function run(state: EditorState, dir: -1 | 1) {
  let next = state;
  const ok = moveBlock(state, dir, (tr: Transaction) => (next = state.apply(tr)));
  return { ok, next };
}
const at = (doc: ReturnType<typeof schema.node>, text: string) => {
  let pos = -1;
  doc.descendants((n, p2) => {
    if (pos < 0 && n.isText && n.text === text) pos = p2 + 1;
  });
  return EditorState.create({ doc, selection: TextSelection.create(doc, pos) });
};

test('moves the paragraph at the cursor up and down, keeping the cursor in it', () => {
  const doc = schema.node('doc', null, [p('one'), p('two'), p('three')]);
  const { next } = run(at(doc, 'two'), -1);
  assert.deepEqual(texts(next), ['two', 'one', 'three']);
  assert.equal(next.selection.$from.parent.textContent, 'two');
  const { next: down } = run(next, 1);
  assert.deepEqual(texts(down), ['one', 'two', 'three']);
  assert.equal(run(at(doc, 'one'), -1).ok, false, 'already first');
  assert.equal(run(at(doc, 'three'), 1).ok, false, 'already last');
});

test('inside a list, the list item moves within its list', () => {
  const doc = schema.node('doc', null, [p('intro'), schema.node('bulletList', null, [li('a'), li('b'), li('c')])]);
  const { next } = run(at(doc, 'c'), -1);
  assert.deepEqual(texts(next), ['intro', '[a,c,b]']);
  assert.equal(run(at(doc, 'a'), -1).ok, false, 'first item stays in the list');
});

test('a selected block (e.g. an image) moves and stays selected', () => {
  const doc = schema.node('doc', null, [p('one'), schema.node('image'), p('two')]);
  const state = EditorState.create({ doc, selection: NodeSelection.create(doc, doc.child(0).nodeSize) });
  const { next } = run(state, 1);
  assert.deepEqual(texts(next), ['one', 'two', 'IMG']);
  assert.ok(next.selection instanceof NodeSelection && next.selection.node.type.name === 'image');
});
