// Incremental code-block highlighting (src/editor/codeHighlight.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { createLowlight, common } from 'lowlight';
import { codeHighlightPlugin } from '../src/editor/codeHighlight.ts';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*' },
    codeBlock: { group: 'block', content: 'text*', code: true, attrs: { language: { default: null } } },
    text: {},
  },
});

function setup() {
  const plugin = codeHighlightPlugin({ name: 'codeBlock', lowlight: createLowlight(common), defaultLanguage: null });
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text('intro')]),
    schema.node('codeBlock', { language: 'javascript' }, [schema.text('const a = 1;')]),
    schema.node('paragraph', null, [schema.text('outro')]),
  ]);
  return { plugin, state: EditorState.create({ doc, plugins: [plugin] }) };
}

const decos = (plugin: ReturnType<typeof setup>['plugin'], state: EditorState) =>
  plugin.getState(state)!.find().map((d) => `${d.from}-${d.to}:${(d as unknown as { type: { attrs: { class: string } } }).type.attrs.class}`);

test('highlights code blocks on load', () => {
  const { plugin, state } = setup();
  const d = decos(plugin, state);
  assert.ok(d.some((x) => x.endsWith('hljs-keyword')), d.join(' '));
});

test('typing in a paragraph maps decorations without re-highlighting', () => {
  const { plugin, state } = setup();
  const before = plugin.getState(state)!.find();
  const next = state.apply(state.tr.insertText('XY', 1));
  const after = plugin.getState(next)!.find();
  assert.equal(after.length, before.length);
  // Shifted by the two inserted characters, same classes.
  assert.deepEqual(after.map((d) => d.from), before.map((d) => d.from + 2));
});

test('editing a code block re-highlights it; changing its language too', () => {
  const { plugin, state } = setup();
  const codePos = state.doc.child(0).nodeSize; // start of the code block
  const s2 = state.apply(state.tr.insertText(' return', codePos + 1 + 'const a = 1;'.length));
  assert.ok(decos(plugin, s2).filter((x) => x.endsWith('hljs-keyword')).length >= 2, 'new keyword highlighted');
  const s3 = s2.apply(s2.tr.setNodeMarkup(codePos, undefined, { language: 'plaintext' }));
  assert.equal(decos(plugin, s3).filter((x) => x.includes('hljs-keyword')).length, 0, 'plain text has no keywords');
});

test('deleting a code block removes its decorations', () => {
  const { plugin, state } = setup();
  const codePos = state.doc.child(0).nodeSize;
  const next = state.apply(state.tr.delete(codePos, codePos + state.doc.child(1).nodeSize));
  assert.equal(plugin.getState(next)!.find().length, 0);
});
