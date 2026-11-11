// Backspace/Enter on an empty last line leaves toggles, callouts and quotes (src/editor/blockExit.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Schema, type Node } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { history, undo } from '@tiptap/pm/history';
import { joinBackward } from '@tiptap/pm/commands';
import { exitEmptyLastLine } from '../src/editor/blockExit.ts';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*' },
    details: { group: 'block', content: 'detailsSummary detailsContent', defining: true, isolating: true },
    detailsSummary: { content: 'text*', defining: true, isolating: true },
    detailsContent: { content: 'block+', defining: true },
    callout: { group: 'block', content: 'block+', defining: true },
    blockquote: { group: 'block', content: 'block+', defining: true },
    text: {},
  },
});
const p = (t = '') => schema.node('paragraph', null, t ? [schema.text(t)] : []);
const toggle = (...kids: Node[]) =>
  schema.node('details', null, [schema.node('detailsSummary', null, [schema.text('Parent')]), schema.node('detailsContent', null, kids)]);
const wrap = (type: string, ...kids: Node[]) => schema.node(type, null, kids);

/** State with the cursor in the last empty paragraph inside the first top-level block. */
function atLastEmpty(doc: Node) {
  let pos = -1;
  doc.firstChild!.descendants((n, p2) => {
    if (n.type.name === 'paragraph' && n.content.size === 0) pos = p2 + 2; // +1 into the block, +1 into the paragraph
  });
  return EditorState.create({ doc, selection: TextSelection.create(doc, pos), plugins: [history()] });
}
const press = (s: EditorState, key: 'Backspace' | 'Enter') => {
  let next = s;
  const ok = exitEmptyLastLine(s, key, (tr) => (next = s.apply(tr)));
  return { ok, next };
};
const shape = (n: Node): unknown =>
  n.isTextblock ? n.textContent : { [n.type.name]: n.content.content.filter((c) => c.type.name !== 'detailsSummary').map(shape) };

test('toggle: Backspace on the empty last line moves it after the toggle, children intact', () => {
  const s = atLastEmpty(schema.node('doc', null, [toggle(p('one'), p('two'), p())]));
  const { ok, next } = press(s, 'Backspace');
  assert.ok(ok);
  assert.deepEqual(next.doc.content.content.map(shape), [{ details: [{ detailsContent: ['one', 'two'] }] }, '']);
  const { $from } = next.selection;
  assert.equal($from.depth, 1);
  assert.equal($from.index(0), 1); // the paragraph after the toggle
  // Second Backspace: the usual join, into the end of the toggle's last child.
  let after = next;
  assert.ok(joinBackward(next, (tr) => (after = next.apply(tr))));
  assert.equal(after.doc.childCount, 1);
  assert.equal(after.selection.$from.parent.textContent, 'two');
  assert.equal(after.selection.$from.parentOffset, 3);
  // One undo restores the line inside the toggle.
  let undone = next;
  undo(next, (tr) => (undone = next.apply(tr)));
  assert.ok(undone.doc.eq(s.doc));
});

test('toggle: Enter on the empty last line exits the same way', () => {
  const s = atLastEmpty(schema.node('doc', null, [toggle(p('one'), p()), p('below')]));
  const { ok, next } = press(s, 'Enter');
  assert.ok(ok);
  assert.deepEqual(next.doc.content.content.map(shape), [{ details: [{ detailsContent: ['one'] }] }, '', 'below']);
  assert.equal(next.selection.$from.index(0), 1);
});

test('toggle: the only empty line stays inside (content must not be empty)', () => {
  const s = atLastEmpty(schema.node('doc', null, [toggle(p())]));
  const { ok, next } = press(s, 'Backspace');
  assert.ok(ok);
  assert.deepEqual(next.doc.content.content.map(shape), [{ details: [{ detailsContent: [''] }] }, '']);
  assert.equal(next.selection.$from.index(0), 1);
});

for (const type of ['callout', 'blockquote']) {
  test(`${type}: Backspace on the empty last line moves it after; the only line is left to unwrap`, () => {
    const s = atLastEmpty(schema.node('doc', null, [wrap(type, p('one'), p())]));
    const { ok, next } = press(s, 'Backspace');
    assert.ok(ok);
    assert.deepEqual(next.doc.content.content.map(shape), [{ [type]: ['one'] }, '']);
    assert.equal(next.selection.$from.index(0), 1);
    assert.equal(press(atLastEmpty(schema.node('doc', null, [wrap(type, p())])), 'Backspace').ok, false);
    assert.equal(press(s, 'Enter').ok, false); // Enter: ProseMirror's liftEmptyBlock already exits
  });
}

test('only the empty last line changes: text, or an empty line that is not last, keep today\'s behaviour', () => {
  const doc = schema.node('doc', null, [toggle(p(), p('two'))]);
  assert.equal(press(atLastEmpty(doc), 'Backspace').ok, false); // empty but not last
  const withText = schema.node('doc', null, [toggle(p('one'), p('two'))]);
  const s = EditorState.create({ doc: withText, selection: TextSelection.create(withText, withText.content.size - 6) });
  assert.equal(s.selection.$from.parent.textContent, 'two');
  assert.equal(press(s, 'Backspace').ok, false);
});

test('nested containers outdent one level at a time', () => {
  const s = atLastEmpty(schema.node('doc', null, [toggle(p('one'), wrap('blockquote', p('q'), p()))]));
  const { next } = press(s, 'Backspace');
  assert.deepEqual(next.doc.content.content.map(shape), [{ details: [{ detailsContent: ['one', { blockquote: ['q'] }, ''] }] }]);
  const { next: out } = press(next, 'Backspace');
  assert.deepEqual(out.doc.content.content.map(shape), [{ details: [{ detailsContent: ['one', { blockquote: ['q'] }] }] }, '']);
});
