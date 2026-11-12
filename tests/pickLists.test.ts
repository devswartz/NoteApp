// Printing picked lines out of a list: items nobody picked, and parents of picked sub-items, print nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Schema, type Node as PMNode } from '@tiptap/pm/model';
import { addRange, pickBlocks, rangeOf, type RangePick } from '../src/editor/linePicksCore.ts';
import { pruneEmptyItems } from '../src/print/selectionContent.ts';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    text: { group: 'inline' },
    bulletList: { group: 'block', content: 'listItem+' },
    orderedList: { group: 'block', content: 'listItem+', attrs: { start: { default: 1 }, continued: { default: false } } },
    listItem: { content: 'paragraph block*' },
  },
});
const n = schema.nodes;
const p = (t: string) => n.paragraph.create(null, t ? schema.text(t) : null);
const li = (t: string, ...nested: PMNode[]) => n.listItem.create(null, [p(t), ...nested]);
const ul = (...items: PMNode[]) => n.bulletList.create(null, items);
const ol = (...items: PMNode[]) => n.orderedList.create({ start: 1 }, items);

/** The range of text `t` in the document. */
function pick(doc: PMNode, t: string): RangePick {
  let found: RangePick | null = null;
  doc.descendants((node, pos) => {
    if (!found && node.isTextblock && node.textContent === t) found = rangeOf(doc, pos + 1, pos + 1 + node.content.size);
    return !found;
  });
  assert.ok(found, `no "${t}"`);
  return found;
}
const picksOf = (doc: PMNode, ...texts: string[]) => texts.reduce<RangePick[]>((acc, t) => addRange(acc, pick(doc, t)), []);

/** A compact outline of printed blocks: "• a", "  ◦ b", "3. c". */
type J = { type?: string; attrs?: Record<string, unknown>; content?: J[]; text?: string };
function outline(blocks: J[], depth = 0): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.type === 'bulletList' || b.type === 'orderedList') {
      (b.content ?? []).forEach((item, i) => {
        const marker = b.type === 'orderedList' ? `${Number(b.attrs?.start) + i}.` : '•';
        const [lead, ...rest] = item.content ?? [];
        out.push(`${'  '.repeat(depth)}${marker} ${(lead?.content ?? []).map((t) => t.text).join('')}`);
        out.push(...outline(rest, depth + 1));
      });
    } else out.push(`${'  '.repeat(depth)}${(b.content ?? []).map((t) => t.text).join('')}`);
  }
  return out;
}

const bullets = n.doc.create(null, [
  ul(li('Control select multiple unrelated things'), li('unpicked one'), li('unpicked two', ul(li('It works amazingly well'), li('unpicked child'))), li('Copy and paste sections'), li('unpicked last')),
]);

test('alternate siblings picked: no empty items between or after them', () => {
  const blocks = pickBlocks(bullets, picksOf(bullets, 'Control select multiple unrelated things', 'Copy and paste sections'));
  assert.deepEqual(outline(blocks), ['• Control select multiple unrelated things', '• Copy and paste sections']);
});

test('only a nested child picked: no empty parent bullet; the child takes its place', () => {
  const blocks = pickBlocks(bullets, picksOf(bullets, 'It works amazingly well'));
  assert.deepEqual(outline(blocks), ['• It works amazingly well']);
});

test('the printout from the bug report: picked lines, a picked child of an unpicked parent, no empty bullets', () => {
  const blocks = pickBlocks(bullets, picksOf(bullets, 'Control select multiple unrelated things', 'It works amazingly well', 'Copy and paste sections'));
  assert.deepEqual(outline(blocks), ['• Control select multiple unrelated things', '• It works amazingly well', '• Copy and paste sections']);
});

test('a parent and one of its children picked: the parent keeps its child, the unpicked child is gone', () => {
  const blocks = pickBlocks(bullets, picksOf(bullets, 'unpicked two'));
  assert.deepEqual(outline(blocks), ['• unpicked two']);
  const one = n.doc.create(null, [ul(li('Parent', ul(li('Child A'), li('Child B'))), li('Other'))]);
  // One range from Parent through Child A: the parent bullet, its picked child, nothing else.
  const a = pick(one, 'Parent');
  const c = pick(one, 'Child A');
  const blocks2 = pickBlocks(one, [{ from: a.from, to: c.to }]);
  assert.deepEqual(outline(blocks2), ['• Parent', '  • Child A']);
});

test('a numbered list with a gap keeps its original numbers and has no empty numbers', () => {
  const doc = n.doc.create(null, [ol(li('one'), li('two'), li('three'), li('four'), li('five'))]);
  const blocks = pickBlocks(doc, picksOf(doc, 'one', 'four', 'five'));
  assert.deepEqual(outline(blocks), ['1. one', '4. four', '5. five']);
  const lone = pickBlocks(doc, picksOf(doc, 'three'));
  assert.deepEqual(outline(lone), ['3. three']);
});

test('pruning: empty items and trailing empty paragraphs go; a split numbered list continues counting', () => {
  const item = (text: string, ...more: J[]): J => ({ type: 'listItem', content: [{ type: 'paragraph', ...(text ? { content: [{ type: 'text', text }] } : {}) }, ...more] });
  const list = (type: string, start: number, ...items: J[]): J => ({ type, attrs: { start, continued: false }, content: items });
  const out = pruneEmptyItems([list('orderedList', 1, item('a'), item(''), item('c', { type: 'paragraph' }), item('', list('bulletList', 1, item('deep'))), item('e'))] as never) as J[];
  assert.deepEqual(outline(out), ['1. a', '3. c', '• deep', '5. e']);
  assert.equal(out[1].content?.[0].content?.length, 1, 'trailing empty paragraph removed from "c"');
});
