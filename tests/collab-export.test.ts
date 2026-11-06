import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { docToMarkdown } from '../src/editor/collabExport.ts';

const el = (name: string, attrs: Record<string, string | number | boolean> = {}, kids: (Y.XmlElement | Y.XmlText)[] = []) => {
  const e = new Y.XmlElement(name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v as string);
  e.insert(0, kids);
  return e;
};
const t = (s: string) => new Y.XmlText(s);

test('docToMarkdown: headings, paragraphs, lists, task lists, quotes, code, task refs', () => {
  const doc = new Y.Doc();
  doc.getXmlFragment('default').insert(0, [
    el('heading', { level: 2 }, [t('Plan')]),
    el('paragraph', {}, [t('Intro text')]),
    el('bulletList', {}, [el('listItem', {}, [el('paragraph', {}, [t('one')])]), el('listItem', {}, [el('paragraph', {}, [t('two')])])]),
    el('orderedList', {}, [el('listItem', {}, [el('paragraph', {}, [t('first')])])]),
    el('taskList', {}, [el('taskItem', { checked: true }, [el('paragraph', {}, [t('done thing')])])]),
    el('blockquote', {}, [el('paragraph', {}, [t('quoted')])]),
    el('codeBlock', {}, [t('let x = 1;')]),
    el('taskRef', { taskId: 'abc' }),
  ]);
  assert.equal(
    docToMarkdown(doc.getXmlFragment('default')),
    ['## Plan', '', 'Intro text', '', '- one', '- two', '', '1. first', '', '- [x] done thing', '', '> quoted', '', '```', 'let x = 1;', '```', '', '- [task] abc', ''].join('\n'),
  );
});
