// Text colour and highlight marks: Yjs round trip, import sanitizer, Markdown export.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from '@tiptap/y-tiptap';
import { colorExtensions } from '../src/editor/colors.ts';
import { sanitizeYDoc } from '../server/sanitizeDoc.ts';
import { toMarkdown } from '../server/markdown.ts';
import { isColorName } from '../shared/colors.ts';

const schema = getSchema([StarterKit, ...colorExtensions]);
const doc = (marks: unknown[]) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi ' }, { type: 'text', text: 'there', marks }] }],
});
type Json = { content?: { content?: { text?: string; marks?: unknown[] }[] }[] };
const marksOf = (json: unknown) => (json as Json).content?.[0]?.content?.[1]?.marks ?? [];

test('palette names only', () => {
  assert.ok(isColorName('red'));
  assert.ok(!isColorName('#ff0000'));
  assert.ok(!isColorName('red; background: url(x)'));
  assert.ok(!isColorName(undefined));
});

test('text colour and highlight survive a Yjs round trip as names', () => {
  const marks = [
    { type: 'textStyle', attrs: { color: 'red' } },
    { type: 'highlight', attrs: { color: 'yellow' } },
  ];
  const ydoc = prosemirrorJSONToYDoc(schema, doc(marks), 'default');
  // A second replica gets the same marks through an update.
  const replica = new Y.Doc();
  Y.applyUpdate(replica, Y.encodeStateAsUpdate(ydoc));
  const back = yDocToProsemirrorJSON(replica, 'default');
  assert.deepEqual(
    (marksOf(back) as { type: string; attrs: { color: string } }[]).map((m) => [m.type, m.attrs.color]).sort(),
    [
      ['highlight', 'yellow'],
      ['textStyle', 'red'],
    ],
  );
});

test('sanitizer keeps palette colours and drops anything else', () => {
  const good = prosemirrorJSONToYDoc(schema, doc([{ type: 'textStyle', attrs: { color: 'blue' } }, { type: 'highlight', attrs: { color: 'green' } }]), 'default');
  sanitizeYDoc(good);
  assert.equal(marksOf(yDocToProsemirrorJSON(good, 'default')).length, 2);

  const bad = prosemirrorJSONToYDoc(schema, doc([{ type: 'textStyle', attrs: { color: '#ff0000' } }, { type: 'highlight', attrs: { color: 'url(x)' } }]), 'default');
  sanitizeYDoc(bad);
  const json = yDocToProsemirrorJSON(bad, 'default');
  const left = marksOf(json) as { type: string; attrs?: { color?: unknown } }[];
  assert.deepEqual(
    left.map((m) => [m.type, m.attrs?.color ?? null]),
    [['highlight', null]], // the highlight stays (default yellow); the unknown text colour is gone
  );
  assert.equal((json as Json).content?.[0]?.content?.map((n) => n.text).join(''), 'Hi there'); // the text stays
});

test('Markdown export drops colours and keeps the text', () => {
  const ydoc = prosemirrorJSONToYDoc(schema, doc([{ type: 'textStyle', attrs: { color: 'red' } }, { type: 'highlight', attrs: { color: 'pink' } }, { type: 'bold' }]), 'default');
  assert.equal(toMarkdown('T', ydoc.getXmlFragment('default'), () => undefined), '# T\n\nHi **there**\n');
});
