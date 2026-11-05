import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from '@tiptap/pm/model';
import { undoRedoChanges, taskRefIds } from '../src/editor/taskRefIds.ts';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*' },
    callout: { group: 'block', content: 'block+' },
    taskRef: { group: 'block', atom: true, attrs: { taskId: { default: null } } },
    text: {},
  },
});
const ref = (id: string) => schema.node('taskRef', { taskId: id });
const p = (t: string) => schema.node('paragraph', null, t ? [schema.text(t)] : []);

test('taskRefIds finds refs at any depth', () => {
  const doc = schema.node('doc', null, [p('x'), ref('a'), schema.node('callout', null, [ref('b')])]);
  assert.deepEqual([...taskRefIds(doc)].sort(), ['a', 'b']);
});

test('undoRedoChanges reports removed and re-added task refs', () => {
  const converted = schema.node('doc', null, [p('intro'), ref('t1'), ref('keep')]);
  const undone = schema.node('doc', null, [p('intro'), p('Buy milk'), ref('keep')]);
  assert.deepEqual(undoRedoChanges(converted, undone), { removed: ['t1'], added: [] });
  assert.deepEqual(undoRedoChanges(undone, converted), { removed: [], added: ['t1'] });
});

test('UndoTaskTracker: undo of a convert deletes, redo recreates, and it can repeat', async () => {
  const { UndoTaskTracker } = await import('../src/editor/taskRefIds.ts');
  const t = new UndoTaskTracker();
  t.created('t1');
  assert.deepEqual(t.undoRedo(['t1'], []), { remove: ['t1'], recreate: [] }, 'undo the convert → delete');
  assert.deepEqual(t.undoRedo([], ['t1']), { remove: [], recreate: ['t1'] }, 'redo → recreate');
  assert.deepEqual(t.undoRedo(['t1'], []), { remove: ['t1'], recreate: [] }, 'undo again → delete again');
});

test('UndoTaskTracker: convert → delete the line → undo → redo leaves the task standalone (never deleted)', async () => {
  const { UndoTaskTracker } = await import('../src/editor/taskRefIds.ts');
  const t = new UndoTaskTracker();
  t.created('t1'); // convert
  t.editRemoved(['t1']); // delete the line: an ordinary edit (task becomes standalone)
  assert.deepEqual(t.undoRedo([], ['t1']), { remove: [], recreate: [] }, 'undo brings the taskRef back; nothing to recreate');
  assert.deepEqual(t.undoRedo(['t1'], []), { remove: [], recreate: [] }, 'redo re-removes it: normal rule, not deleted');
  assert.equal(t.hasEligible(), false);
});

test('UndoTaskTracker: tasks from other sessions are never deleted by undo', async () => {
  const { UndoTaskTracker } = await import('../src/editor/taskRefIds.ts');
  const t = new UndoTaskTracker();
  assert.deepEqual(t.undoRedo(['old'], []), { remove: [], recreate: [] });
});

test('taskRefsDeletedBy only reports taskRefs inside deleted ranges', async () => {
  const { EditorState } = await import('@tiptap/pm/state');
  const { taskRefsDeletedBy } = await import('../src/editor/taskRefIds.ts');
  const doc = schema.node('doc', null, [p('a'), ref('t1'), p('b'), ref('t2')]);
  const state = EditorState.create({ doc });
  const start = doc.child(0).nodeSize;
  const tr = state.tr.delete(start, start + doc.child(1).nodeSize); // delete the t1 block
  assert.deepEqual([...taskRefsDeletedBy(tr)], ['t1']);
  const typing = state.tr.insertText('x', 1);
  assert.equal(taskRefsDeletedBy(typing).size, 0);
});
