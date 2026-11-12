// Word-style outlines (src/editor/smartLists.ts): typed markers and the exports' list markers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { listMarker, listStarts, resolveListStarts } from '../shared/listMarker.ts';
import { toMarkdown } from '../server/markdown.ts';
import { docToMarkdown } from '../src/editor/collabExport.ts';
import { letterListInputRegex, parenListInputRegex } from '../src/editor/smartLists.ts';

const el = (name: string, attrs: Record<string, string | number> = {}, kids: (Y.XmlElement | Y.XmlText)[] = []) => {
  const e = new Y.XmlElement(name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v as string);
  e.insert(0, kids);
  return e;
};
const item = (text: string, ...nested: Y.XmlElement[]) => el('listItem', {}, [el('paragraph', {}, [new Y.XmlText(text)]), ...nested]);

test('typed markers: "a. " "A) " "i. " "I. " and "1) " start lists; words and other letters do not', () => {
  for (const s of ['a. ', 'A) ', 'i. ', 'I. ']) assert.ok(letterListInputRegex.test(s), s);
  for (const s of ['b. ', 'e.g. ', 'ab. ', 'a.', ' a. ']) assert.ok(!letterListInputRegex.test(s), s);
  assert.equal('3) '.match(parenListInputRegex)?.[1], '3');
  assert.ok(!parenListInputRegex.test('1. ')); // TipTap's own rule
});

test('listMarker: numbers, letters past z, roman numerals', () => {
  assert.equal(listMarker(null, 3), '3');
  assert.equal(listMarker('a', 1), 'a');
  assert.equal(listMarker('a', 27), 'aa');
  assert.equal(listMarker('A', 2), 'B');
  assert.equal(listMarker('i', 4), 'iv');
  assert.equal(listMarker('I', 14), 'XIV');
});

test('continued lists: numbering carries on across a split, a new list restarts', () => {
  const ol = (items: number, attrs: Record<string, unknown> = {}) => ({ type: 'orderedList', attrs, content: Array.from({ length: items }, () => ({ type: 'listItem' })) });
  const doc: { type: string; attrs?: Record<string, unknown>; content: { type: string; attrs?: Record<string, unknown> }[] } = { type: 'doc', content: [ol(2), { type: 'paragraph' },ol(2, { continued: true }), ol(1, { continued: true }), ol(1), ol(1, { start: 7 })] };
  const starts = resolveListStarts(doc).content.map((c) => (c.type === 'orderedList' ? c.attrs?.start ?? 1 : null));
  assert.deepEqual(starts, [1, null, 3, 5, 1, 7]);
  assert.deepEqual(listStarts([{ ordered: true, start: 4, continued: false, items: 2 }, { ordered: false, start: 1, continued: false, items: 0 }, { ordered: true, start: 1, continued: true, items: 1 }]), [4, undefined, 6]);
});

test('exports: a split list keeps counting and "1)" lists keep their parenthesis', () => {
  const doc = new Y.Doc();
  const frag = doc.getXmlFragment('default');
  frag.insert(0, [
    el('orderedList', {}, [item('One'), item('Two')]),
    el('paragraph', {}, [new Y.XmlText('Note')]),
    el('orderedList', { continued: 'true' }, [item('Three')]),
    el('orderedList', { paren: 'true' }, [item('Paren')]),
  ]);
  const server = toMarkdown('Split', frag, () => undefined);
  assert.match(server, /3\. Three/);
  assert.match(server, /1\) Paren/);
  const local = docToMarkdown(frag);
  assert.match(local, /3\. Three/);
  assert.match(local, /1\) Paren/);
});

test('exports: nested outline keeps its levels, start numbers and typed markers', () => {
  const doc = new Y.Doc();
  const frag = doc.getXmlFragment('default');
  frag.insert(0, [
    el('orderedList', {}, [item('One', el('orderedList', {}, [item('Sub a'), item('Sub b')])), item('Two')]),
    el('orderedList', { start: 4 }, [item('Four')]),
    el('orderedList', { type: 'a' }, [item('Alpha'), item('Beta')]),
  ]);
  const server = toMarkdown('Outline', frag, () => undefined);
  assert.match(server, /1\. One\n {2}1\. Sub a\n {2}2\. Sub b\n2\. Two/);
  assert.match(server, /4\. Four/);
  assert.match(server, /a\. Alpha\nb\. Beta/);
  const local = docToMarkdown(frag);
  assert.match(local, /1\. One\n {2}1\. Sub a\n {2}2\. Sub b\n2\. Two/);
  assert.match(local, /4\. Four/);
  assert.match(local, /b\. Beta/);
});
