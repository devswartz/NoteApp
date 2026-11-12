import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JSONContent } from '@tiptap/core';
import { PASTE_STEP, clipText, jsonText, mapTaskRefs, placeBoxes, textBlocks, type ClipBox } from '../src/editor/boxClipboard.ts';

const p = (t: string): JSONContent => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });
const box = (x: number, y: number, content = [p('hi')]): ClipBox => ({ x, y, w: 300, content });

test('box text: one line per block, lists and tables flattened', () => {
  assert.equal(jsonText([p('One'), p('Two')]), 'One\nTwo');
  const list = { type: 'bulletList', content: [{ type: 'listItem', content: [p('a')] }, { type: 'listItem', content: [p('b')] }] };
  assert.equal(jsonText([list]), 'a\nb');
  assert.equal(jsonText([{ type: 'paragraph' }]), '');
  assert.equal(clipText([box(0, 0, [p('A')]), box(0, 0, [{ type: 'paragraph' }]), box(0, 0, [p('B')])]), 'A\n\nB');
});

test('pasted text becomes a paragraph per line', () => {
  assert.deepEqual(textBlocks('a\r\n\nb'), [p('a'), { type: 'paragraph' }, p('b')]);
});

test('placing pasted boxes: a right-click puts the group top-left there; otherwise it steps off what is already there', () => {
  const two = [box(100, 200), box(300, 260)];
  const at = placeBoxes(two, { at: { x: 10, y: 20 }, existing: [] });
  assert.deepEqual(at.map((b) => [b.x, b.y]), [[10, 20], [210, 80]], 'relative positions kept');
  assert.deepEqual(placeBoxes(two, { existing: [] }).map((b) => [b.x, b.y]), [[100, 200], [300, 260]], 'nothing in the way: same place');
  const nudged = placeBoxes(two, { existing: [{ x: 100, y: 200 }] });
  assert.deepEqual(nudged.map((b) => [b.x, b.y]), [[100 + PASTE_STEP, 200 + PASTE_STEP], [300 + PASTE_STEP, 260 + PASTE_STEP]]);
  const twice = placeBoxes(two, { existing: [{ x: 100, y: 200 }, { x: 100 + PASTE_STEP, y: 200 + PASTE_STEP }] });
  assert.equal(twice[0].x, 100 + 2 * PASTE_STEP, 'a third copy steps again');
  assert.equal(placeBoxes([box(5, 5)], { at: { x: -50, y: -50 }, existing: [] })[0].x, 0, 'never off the left or top edge');
});

test('task references in pasted boxes can be swapped for new tasks', () => {
  const blocks: JSONContent[] = [p('x'), { type: 'taskRef', attrs: { taskId: 't1' } }, { type: 'blockquote', content: [{ type: 'taskRef', attrs: { taskId: 't2' } }] }];
  const out = mapTaskRefs(blocks, (id) => (id === 't1' ? 'n1' : null));
  assert.equal((out[1].attrs as { taskId: string }).taskId, 'n1');
  assert.equal((out[2].content![0].attrs as { taskId: string }).taskId, 't2', 'a task that could not be cloned keeps its reference');
  assert.equal((blocks[1].attrs as { taskId: string }).taskId, 't1', 'the copied content is not changed');
});

// ───── lists on the clipboard: text with markers, and text that becomes lists ─────
import { blocksText } from '../src/editor/boxClipboard.ts';

const para = (t: string) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });
const item = (t: string, ...nested: object[]) => ({ type: 'listItem', content: [para(t), ...nested] });

test('blocks as text keep list markers, numbering and nesting', () => {
  const blocks = [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
    { type: 'bulletList', content: [item('one', { type: 'bulletList', content: [item('inner')] }), item('two')] },
    { type: 'orderedList', attrs: { start: 3 }, content: [item('three'), item('four')] },
    { type: 'taskRef', attrs: { taskId: 't1' } },
  ];
  assert.equal(blocksText(blocks, (id) => `[ ] task ${id}`), ['Title', '- one', '  - inner', '- two', '3. three', '4. four', '[ ] task t1'].join('\n'));
});

test('pasted plain text: "- ", "* ", "• " and "1. " lines become lists; indentation nests; other lines stay paragraphs', () => {
  const blocks = textBlocks(['Intro', '- one', '  - nested', '  - nested two', '- two', '', '1. first', '2) second', '   - under second', 'after'].join('\n'));
  const names = blocks.map((b) => b.type);
  assert.deepEqual(names, ['paragraph', 'bulletList', 'paragraph', 'orderedList', 'paragraph']);
  const bullets = blocks[1]!.content!;
  assert.equal(bullets.length, 2);
  assert.equal(bullets[0]!.content![1]!.type, 'bulletList', 'the indented lines nest under "one"');
  assert.equal(bullets[0]!.content![1]!.content!.length, 2);
  assert.equal(blocks[3]!.attrs!.start, 1);
  assert.equal(blocks[3]!.content![1]!.content![1]!.type, 'bulletList');
  // Round trip: the text of those blocks reads back as the same lists.
  assert.deepEqual(textBlocks(blocksText(blocks)).map((b) => b.type), ['paragraph', 'bulletList', 'paragraph', 'orderedList', 'paragraph']);
});

test('pasted text: a numbered list keeps its first number, and plain lines with a dash inside are not lists', () => {
  assert.equal(textBlocks('4. four\n5. five')[0]!.attrs!.start, 4);
  assert.deepEqual(textBlocks('well - not a list\n-also not\n2024 was long').map((b) => b.type), ['paragraph', 'paragraph', 'paragraph']);
});
