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
