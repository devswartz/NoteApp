// Notes under a task (src/editor/taskChildren.ts): converting keeps sub-points, Tab / Shift+Tab, Enter out,
// unwrapping keeps notes, block moves carry them. Pure ProseMirror on a schema shaped like the editor's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Schema, type Node as PMNode } from '@tiptap/pm/model';
import { EditorState, NodeSelection, TextSelection, type Transaction } from '@tiptap/pm/state';
import {
  addChecklistToTask,
  taskNear,
  convertTransaction,
  exitEmptyLastChild,
  firstLineOfTask,
  indentIntoTask,
  liftOutOfTask,
  plainGoneTasks,
  shiftTabBlock,
  tabBlock,
  unwrapTask,
} from '../src/editor/taskChildren.ts';
import { moveBlock } from '../src/editor/blockMove.ts';
import { taskRefsDeletedBy } from '../src/editor/taskRefIds.ts';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*' },
    bulletList: { group: 'block', content: 'listItem+' },
    orderedList: { group: 'block', content: 'listItem+', attrs: { start: { default: 1 }, continued: { default: false } } },
    listItem: { content: 'paragraph block*' },
    taskList: { group: 'block', content: 'taskItem+' },
    taskItem: { content: 'paragraph block*', attrs: { checked: { default: false } } },
    taskRef: { group: 'block', content: 'block*', isolating: true, selectable: true, attrs: { taskId: { default: null } } },
    codeBlock: { group: 'block', content: 'text*', code: true },
    text: {},
  },
});
const p = (t = '') => schema.node('paragraph', null, t ? [schema.text(t)] : []);
const li = (t: string, ...kids: PMNode[]) => schema.node('listItem', null, [p(t), ...kids]);
const ul = (...items: PMNode[]) => schema.node('bulletList', null, items);
const ci = (t: string, checked = false) => schema.node('taskItem', { checked }, [p(t)]);
const cl = (...items: PMNode[]) => schema.node('taskList', null, items);
const task = (id: string, ...kids: PMNode[]) => schema.node('taskRef', { taskId: id }, kids);
const doc = (...blocks: PMNode[]) => schema.node('doc', null, blocks);

/** A compact outline: "T:id{...}" tasks, "[a,b{...}]" bullet lists, "☐a" / "☑a" checklist items, "x" paragraphs. */
function shape(n: PMNode): string {
  const kids = (m: PMNode) => {
    const out: string[] = [];
    m.forEach((c) => out.push(shape(c)));
    return out.join(',');
  };
  switch (n.type.name) {
    case 'doc':
      return kids(n);
    case 'taskRef':
      return `T:${n.attrs.taskId}${n.childCount ? `{${kids(n)}}` : ''}`;
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return `[${kids(n)}]`;
    case 'listItem':
    case 'taskItem': {
      const rest: string[] = [];
      n.forEach((c, _o, i) => i > 0 && rest.push(shape(c)));
      const mark = n.type.name === 'taskItem' ? (n.attrs.checked ? '☑' : '☐') : '';
      return `${mark}${n.firstChild!.textContent}${rest.length ? `{${rest.join(',')}}` : ''}`;
    }
    default:
      return n.textContent;
  }
}

/** A state with the cursor at the end of the first text `text` (or a selection from `text` to `to`). */
function at(d: PMNode, text: string, to?: string) {
  const find = (t: string, end: boolean) => {
    let pos = -1;
    d.descendants((n, q) => {
      if (pos < 0 && n.isText && n.text === t) pos = q + (end ? t.length : 0);
    });
    assert.ok(pos >= 0, `text ${t}`);
    return pos;
  };
  const from = to ? find(text, false) + 1 : find(text, true);
  return EditorState.create({ doc: d, selection: TextSelection.create(d, from, to ? find(to, true) : from) });
}
function apply(state: EditorState, fn: (s: EditorState, dispatch: (tr: Transaction) => void) => boolean) {
  let next = state;
  const ok = fn(state, (tr) => (next = state.apply(tr)));
  return { ok, next };
}
function convert(state: EditorState) {
  let n = 0;
  const made: { title: string; done: boolean }[] = [];
  const res = convertTransaction(state, (title, done) => {
    made.push({ title, done });
    return `n${++n}`;
  });
  return { next: res ? state.apply(res.tr) : state, ids: res?.ids ?? [], made };
}

test('converting a bullet keeps its sub-bullets under the new task, exactly as they were', () => {
  const d = doc(ul(li('Call vendor', ul(li('ask about pricing'), li('get a quote', ul(li('by Friday'))))), li('Other')));
  const { next, ids, made } = convert(at(d, 'Call vendor'));
  assert.deepEqual(ids, ['n1']);
  assert.deepEqual(made, [{ title: 'Call vendor', done: false }]);
  assert.equal(shape(next.doc), 'T:n1{[ask about pricing,get a quote{[by Friday]}]},[Other]');
});

test('a checklist under a bullet stays under the new task; a ticked checklist line becomes a done task', () => {
  const d = doc(ul(li('Pack', cl(ci('tent', true), ci('stove')))));
  assert.equal(shape(convert(at(d, 'Pack')).next.doc), 'T:n1{[☑tent,☐stove]}');
  const c = convert(at(doc(cl(ci('Done thing', true))), 'Done thing'));
  assert.deepEqual(c.made, [{ title: 'Done thing', done: true }]);
});

test('a nested bullet becomes a task where it is: its own sub-points come along, its siblings stay', () => {
  const d = doc(ul(li('A', ul(li('B', ul(li('B1'))), li('C'))), li('D')));
  const { next } = convert(at(d, 'B'));
  assert.equal(shape(next.doc), '[A{T:n1{[B1]},[C]},D]');
});

test('a selection over a line and its own sub-points converts only the line: the sub-points stay plain notes', () => {
  const d = doc(p('intro'), ul(li('A', ul(li('A1'), li('A2'))), li('B')), p('after'));
  const { next, ids } = convert(at(d, 'A', 'B'));
  assert.equal(ids.length, 2, 'A and B, not A1 / A2');
  assert.equal(shape(next.doc), 'intro,T:n1{[A1,A2]},T:n2,after');
  // "Pack for the trip" with its checklist, all selected: one task, the checklist untouched.
  const items = Array.from({ length: 25 }, (_, i) => ci(`item ${i + 1}`, i < 12));
  const trip = doc(ul(li('Pack for the trip', cl(...items))));
  const c = convert(at(trip, 'Pack for the trip', 'item 25'));
  assert.deepEqual(c.made, [{ title: 'Pack for the trip', done: false }]);
  assert.equal(c.next.doc.firstChild!.firstChild!.childCount, 25);
  // A selection only inside a task's notes is an explicit convert: those lines become subtasks.
  const inTask = doc(task('t1', ul(li('x'), li('y'))));
  assert.equal(shape(convert(at(inTask, 'x', 'y')).next.doc), 'T:t1{T:n1,T:n2}');
  // A selection over a whole task leaves it, notes and all, as it is.
  const over = doc(p('a'), task('t1', ul(li('x'))), p('b'));
  assert.equal(shape(convert(at(over, 'a', 'b')).next.doc), 'T:n1,T:t1{[x]},T:n2');
});

test('a line inside a task’s notes becomes a task in place (the server makes it a subtask)', () => {
  const d = doc(task('t1', ul(li('one'), li('two'))), p('after'));
  assert.equal(shape(convert(at(d, 'one')).next.doc), 'T:t1{T:n1,[two]},after');
  const d2 = doc(task('t1', p('note')));
  assert.equal(shape(convert(at(d2, 'note')).next.doc), 'T:t1{T:n1}');
});

test('converting never creates tasks when the result would not fit', () => {
  const d = doc(schema.node('codeBlock', null, [schema.text('code')]));
  const c = convert(at(d, 'code'));
  assert.deepEqual(c.made, []);
});

test('Tab on the first line of a list right below a task moves the whole list in (joining a list there)', () => {
  const d = doc(task('t1', ul(li('a'))), ul(li('b', ul(li('b1'))), li('c')), p('after'));
  const s = at(d, 'b');
  const { ok, next } = apply(s, (st, dispatch) => indentIntoTask(st, tabBlock(st), dispatch));
  assert.ok(ok);
  assert.equal(shape(next.doc), 'T:t1{[a,b{[b1]},c]},after');
  assert.equal(next.selection.$from.parent.textContent, 'b', 'the cursor stays on its line');
  // A checklist below a task goes in the same way.
  const d2 = doc(task('t1'), cl(ci('x'), ci('y')));
  assert.equal(shape(apply(at(d2, 'x'), (st, dispatch) => indentIntoTask(st, tabBlock(st), dispatch)).next.doc), 'T:t1{[☐x,☐y]}');
});

test('Tab leaves list nesting to the list: only the first line of a top-level list, or a plain line', () => {
  const d = doc(task('t1'), ul(li('a'), li('b')));
  assert.equal(tabBlock(at(d, 'b')), null, 'second item: Tab nests it in the list');
  assert.equal(apply(at(doc(p('x'), p('y')), 'y'), (st, dispatch) => indentIntoTask(st, tabBlock(st), dispatch)).ok, false, 'no task above');
  const d2 = doc(task('t1', p('n')), p('plain'));
  const r = apply(at(d2, 'plain'), (st, dispatch) => indentIntoTask(st, tabBlock(st), dispatch));
  assert.equal(shape(r.next.doc), 'T:t1{n,plain}');
});

test('a selected task tabs into the task above it, and Shift+Tab lifts it out again', () => {
  const d = doc(task('t1'), task('t2', p('n2')));
  const sel = EditorState.create({ doc: d, selection: NodeSelection.create(d, d.child(0).nodeSize) });
  const { next } = apply(sel, (st, dispatch) => indentIntoTask(st, tabBlock(st), dispatch));
  assert.equal(shape(next.doc), 'T:t1{T:t2{n2}}');
  assert.ok(next.selection instanceof NodeSelection && next.selection.node.attrs.taskId === 't2');
  const back = apply(next, (st, dispatch) => liftOutOfTask(st, shiftTabBlock(st), dispatch));
  assert.equal(shape(back.next.doc), 'T:t1,T:t2{n2}');
});

test('Shift+Tab on a note line moves it out to just below the task; Enter on an empty last line leaves the task', () => {
  const d = doc(task('t1', p('one'), p('two')), p('after'));
  const { next } = apply(at(d, 'one'), (st, dispatch) => liftOutOfTask(st, shiftTabBlock(st), dispatch));
  assert.equal(shape(next.doc), 'T:t1{two},one,after');
  assert.equal(next.selection.$from.parent.textContent, 'one');
  const e = doc(task('t1', p('one'), p()), p('after'));
  let pos = 0;
  e.descendants((n, q) => {
    if (n.type.name === 'paragraph' && !n.content.size) pos = q + 1;
  });
  const s = EditorState.create({ doc: e, selection: TextSelection.create(e, pos) });
  const r = apply(s, exitEmptyLastChild);
  assert.ok(r.ok);
  assert.equal(shape(r.next.doc), 'T:t1{one},,after');
  assert.equal(apply(at(e, 'one'), exitEmptyLastChild).ok, false, 'only an empty last line');
});

test('Add checklist: an empty plain checklist at the top of the task’s notes, caret in it; found from a line in or below the task', () => {
  const d = doc(task('t1', p('note')), p('below'), p('far'));
  assert.equal(taskNear(at(d, 'note').selection.$from), 0);
  assert.equal(taskNear(at(d, 'below').selection.$from), 0);
  assert.equal(taskNear(at(d, 'far').selection.$from), -1);
  const s = EditorState.create({ doc: d });
  const tr = s.tr;
  assert.ok(addChecklistToTask(tr, 0));
  const next = s.apply(tr);
  assert.equal(shape(next.doc), 'T:t1{[☐],note},below,far');
  assert.equal(next.selection.$from.node(-1).type.name, 'taskItem');
});

test('the first line of a task’s notes is found for ↑ (to the title)', () => {
  const d = doc(task('t1', ul(li('first'), li('second'))));
  assert.equal(firstLineOfTask(at(d, 'first').selection.$from), 1);
  assert.equal(firstLineOfTask(at(d, 'second').selection.$from), -1);
});

test('unwrapping a task keeps its notes in its place; deleted subtasks in them stay as plain lines', () => {
  const d = doc(p('before'), task('t1', ul(li('note')), task('s1', p('sub note'))), p('after'));
  const s = EditorState.create({ doc: d });
  const plain = s.apply(unwrapTask(s.tr, d.child(0).nodeSize, [], (id) => (id === 's1' ? 'Subtask title' : undefined)));
  assert.equal(shape(plain.doc), 'before,[note],Subtask title,sub note,after');
  const kept = s.apply(unwrapTask(s.tr, d.child(0).nodeSize));
  assert.equal(shape(kept.doc), 'before,[note],T:s1{sub note},after');
  const lead = s.apply(unwrapTask(s.tr, d.child(0).nodeSize, [p('')]));
  assert.equal(shape(lead.doc), 'before,,[note],T:s1{sub note},after');
  assert.equal(plainGoneTasks(doc(task('x')).content, () => '').size, 0, 'an untitled gone task with no notes leaves nothing');
});

test('a task with notes moves as one block; a note line moves among the notes', () => {
  const d = doc(p('top'), task('t1', p('n1'), p('n2')));
  const sel = EditorState.create({ doc: d, selection: NodeSelection.create(d, d.child(0).nodeSize) });
  let next = sel;
  moveBlock(sel, -1, (tr) => (next = sel.apply(tr)));
  assert.equal(shape(next.doc), 'T:t1{n1,n2},top');
  const s2 = at(d, 'n2');
  let n2 = s2;
  assert.ok(moveBlock(s2, -1, (tr) => (n2 = s2.apply(tr))));
  assert.equal(shape(n2.doc), 'top,T:t1{n2,n1}');
  assert.equal(moveBlock(at(d, 'n1'), -1), false, 'the first note stays in its task (Shift+Tab takes it out)');
});

test('typing in a task’s notes does not count as removing the task (undo of a convert still works)', () => {
  const d = doc(task('t1', p('abc')));
  const s = at(d, 'abc');
  const tr = s.tr.delete(s.selection.from - 1, s.selection.from);
  assert.deepEqual([...taskRefsDeletedBy(tr)], []);
  const whole = EditorState.create({ doc: d }).tr.delete(0, d.child(0).nodeSize);
  assert.deepEqual([...taskRefsDeletedBy(whole)], ['t1']);
});
