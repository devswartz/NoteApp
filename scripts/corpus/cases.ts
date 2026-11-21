// The page-format corpus cases (tests/corpus/README.md). Each builds a page's Y.Doc the way
// today's app does: block content goes through the editor's schema and y-prosemirror's
// conversion (the same shape the live editor writes), geometry and settings through
// shared/pageDoc.ts. Add a case when the editor or page format gains something.
import * as Y from 'yjs';
import { prosemirrorJSONToYXmlFragment } from '@tiptap/y-tiptap';
import { BOXES_KEY, DEFAULT_FIELD, INK_KEY, PAGE_FORMAT_KEY, boxField, convertPageDoc, newBoxMap, setPageSettings, type BoxGeom } from '../../shared/pageDoc.ts';
import { schema } from './schema.ts';

type J = Record<string, unknown>;
export type TaskInfo = { title: string; done: boolean; due?: string | null } | null;

export interface Case {
  name: string;
  about: string;
  title: string;
  /** What the task lookup returns for each id (server/markdown.ts TaskLookup); ids not listed are unknown (undefined). */
  tasks: Record<string, TaskInfo>;
  build: (doc: Y.Doc) => void;
}

// ── ProseMirror JSON helpers ──
type Inline = J | string;
type MarkSpec = string | [string, J];
const markJson = (m: MarkSpec) => (typeof m === 'string' ? { type: m } : { type: m[0], attrs: m[1] });
export const t = (text: string, ...marks: MarkSpec[]): J => (marks.length ? { type: 'text', text, marks: marks.map(markJson) } : { type: 'text', text });
const inl = (c: Inline[]) => c.map((x) => (typeof x === 'string' ? t(x) : x));
export const p = (...c: Inline[]): J => (c.length ? { type: 'paragraph', content: inl(c) } : { type: 'paragraph' });
export const h = (level: number, ...c: Inline[]): J => ({ type: 'heading', attrs: { level }, content: inl(c) });
const node = (type: string, attrs: J | null, content?: J[]): J => ({ type, ...(attrs ? { attrs } : {}), ...(content ? { content } : {}) });
const li = (...c: J[]) => node('listItem', null, c);
const ti = (checked: boolean, ...c: J[]) => node('taskItem', { checked }, c);
const ul = (...items: J[]) => node('bulletList', null, items);
const ol = (attrs: J | null, ...items: J[]) => node('orderedList', attrs, items);
const tl = (...items: J[]) => node('taskList', null, items);
const task = (taskId: string, ...notes: J[]) => node('taskRef', { taskId }, notes.length ? notes : undefined);
const mention = (id: string, label: string) => node('mention', { id, label });
const pageLink = (pageId: string) => node('pageLink', { pageId });
const hardBreak = { type: 'hardBreak' };
const cell = (kind: 'tableCell' | 'tableHeader', text: string) => node(kind, null, [text ? p(text) : p()]);
const row = (kind: 'tableCell' | 'tableHeader', ...texts: string[]) => node('tableRow', null, texts.map((x) => cell(kind, x)));

/** Write blocks into a fragment the way the editor's y-prosemirror binding stores them. */
function write(doc: Y.Doc, field: string, blocks: J[]) {
  prosemirrorJSONToYXmlFragment(schema, { type: 'doc', content: blocks }, doc.getXmlFragment(field));
}
function box(doc: Y.Doc, g: BoxGeom, blocks: J[]) {
  doc.transact(() => {
    doc.getMap(BOXES_KEY).set(g.id, newBoxMap(g));
    if (blocks.length) write(doc, boxField(g.id), blocks);
  });
}
const wideBox = (id: string, blocks: J[]) => (doc: Y.Doc) => box(doc, { id, x: 0, y: 0, w: 686, z: 1, wide: true }, blocks);
/** A stroke blob (nv-ink's format starts with its version byte; the corpus only needs opaque bytes). */
const blob = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff);

export const CASES: Case[] = [
  {
    name: 'empty',
    about: 'A blank page: nothing typed yet, no boxes.',
    title: '',
    tasks: {},
    build: () => {},
  },
  {
    name: 'document-page',
    about: 'An old document page: content in `default`, no boxes. Text blocks and every inline mark.',
    title: 'Document page',
    tasks: {},
    build: (doc) =>
      write(doc, DEFAULT_FIELD, [
        h(1, 'Heading one'),
        h(2, 'Heading ', t('two', 'italic')),
        h(3, 'Heading three'),
        p('Plain, ', t('bold', 'bold'), ', ', t('italic', 'italic'), ', ', t('underline', 'underline'), ', ', t('strike', 'strike'), ', ', t('code', 'code'), '.'),
        p(t('bold italic', 'bold', 'italic'), ' and ', t('code wins', 'code', 'bold')),
        p('A ', t('link', ['link', { href: 'https://example.com/a?b=1' }]), ' and a ', t('bold link', 'bold', ['link', { href: 'mailto:someone@example.com' }]), '.'),
        p(t('red text', ['textStyle', { color: 'red' }]), ' ', t('green highlight', ['highlight', { color: 'green' }]), ' ', t('default highlight', 'highlight')),
        p('Comment ', t('one', ['comment', { threadId: 'thread-1' }]), t(' both', ['comment', { threadId: 'thread-1' }], ['comment', { threadId: 'thread-2' }]), ' end'),
        p('Line one', hardBreak, 'line two'),
        p(),
        node('blockquote', null, [p('Quoted ', t('text', 'bold')), p('Second quoted line')]),
        node('horizontalRule', null),
        node('codeBlock', { language: 'ts' }, [t('const a = 1;\nconsole.log(a | 2);')]),
        node('codeBlock', null, [t('plain code')]),
        p('Unicode: café, 日本語, emoji 🎉, combining é.'),
      ]),
  },
  {
    name: 'lists',
    about: 'Bullet, numbered (start, letters, roman, ")" markers, continued numbering) and checklists, nested.',
    title: 'Lists',
    tasks: {},
    build: wideBox('b1', [
      ul(li(p('Bullet one'), ul(li(p('Nested bullet')), li(p('Nested two')))), li(p('Bullet two'))),
      ol(null, li(p('First')), li(p('Second'), ol({ type: 'a' }, li(p('Letter a')), li(p('Letter b')))), li(p('Third'))),
      p('A paragraph between lists'),
      ol({ continued: true }, li(p('Carries on (4)')), li(p('Five'))),
      ol({ start: 7, paren: true }, li(p('Seven)')), li(p('Eight)'))),
      ul(li(p('A bullet list between numbered ones'))),
      ol({ continued: true }, li(p('Continued after a bullet list'))),
      ol({ type: 'I' }, li(p('Roman I')), li(p('Roman II')), li(p('Roman III')), li(p('Roman IV')), li(p('Roman V'))),
      ol({ type: 'i', start: 48, paren: true }, li(p('xlviii')), li(p('xlix'))),
      ol({ type: 'A', start: 26 }, li(p('Z')), li(p('AA')), li(p('AB'))),
      tl(ti(false, p('Open item')), ti(true, p('Done item'), tl(ti(false, p('Nested open'))))),
    ]),
  },
  {
    name: 'tasks',
    about: 'Task lines (taskRef) with notes: sub-bullets, checklists and subtasks; hidden, unknown and due tasks.',
    title: 'Tasks',
    tasks: {
      t1: { title: 'Write the plan', done: false, due: '2026-11-30' },
      t2: { title: 'Ship it', done: true },
      t3: { title: 'Subtask', done: false, due: null },
      hidden: null,
    },
    build: wideBox('main', [
      p('Before the tasks'),
      task('t1', ul(li(p('A note under the task'))), tl(ti(true, p('Checked step')), ti(false, p('Open step'))), task('t3')),
      task('t2'),
      task('unknown', p('Notes of a task nobody can see')),
      task('hidden', p('Left out with its task')),
      p('After the tasks'),
      task(''),
    ]),
  },
  {
    name: 'blocks',
    about: 'Callout, toggle, table, image, file card, mentions and page links.',
    title: 'Blocks',
    tasks: {},
    build: wideBox('only', [
      node('callout', { emoji: '⚠️' }, [h(2, 'Heading in a callout'), p('Callout body')]),
      node('callout', null, [p('Default emoji')]),
      node('details', null, [node('detailsSummary', null, [t('Toggle title')]), node('detailsContent', null, [h(3, 'Heading in a toggle'), p('Hidden body')])]),
      node('table', null, [row('tableHeader', 'Name', 'Value'), row('tableCell', 'a | b', '1'), row('tableCell', 'c', '')]),
      node('image', { src: '/uploads/0123456789abcdef0123456789abcdef.png', alt: 'A picture', title: null }),
      node('image', { src: 'https://example.com/i.jpg' }),
      node('fileAttachment', { url: '/files/report.pdf', name: 'report.pdf', size: 12345, mime: 'application/pdf' }),
      p('Hi ', mention('u1', 'Devon'), ' and ', mention('u2', ''), ', see ', pageLink('page-2'), '.'),
      h(1, '   '),
    ]),
  },
  {
    name: 'canvas-boxes',
    about: 'A canvas: boxes in reading order (y, then x, then id), a wide box, empty boxes, headings per box.',
    title: 'Canvas',
    tasks: { tb: { title: 'Task in box b', done: false } },
    build: (doc) => {
      box(doc, { id: 'c', x: 500, y: 300, w: 300, z: 3 }, [h(2, 'Right lower'), p('Box c')]);
      box(doc, { id: 'a', x: 20, y: 300, w: 300, z: 2 }, [h(1, 'Left lower'), p('Box a')]);
      box(doc, { id: 'b', x: 20, y: 300, w: 250, z: 5 }, [p('Same place as a, id breaks the tie'), task('tb')]);
      box(doc, { id: 'top', x: 900, y: -40.5, w: 686, z: 1, wide: true }, [h(1, 'Top box'), p('First in reading order')]);
      box(doc, { id: 'empty', x: 0, y: 1000, w: 400, z: 4 }, []);
      box(doc, { id: 'blank', x: 0, y: 1200, w: 400, z: 6 }, [p()]);
    },
  },
  {
    name: 'converted',
    about: 'A document page turned into a canvas by convertPageDoc (one wide box, `default` emptied).',
    title: 'Converted',
    tasks: {},
    build: (doc) => {
      write(doc, DEFAULT_FIELD, [h(1, 'Was a document'), p('Its text moved into a box'), ul(li(p('With its list')))]);
      convertPageDoc(doc, 'canvas', () => 'conv1');
    },
  },
  {
    name: 'settings-and-ink',
    about: 'Page colour and rule lines, ink strokes (one value that is not a blob), format version 2.',
    title: 'Settings and ink',
    tasks: {},
    build: (doc) => {
      wideBox('b', [p('Handwriting below')])(doc);
      setPageSettings(doc, { color: 'blue', rules: 'grid' });
      const ink = doc.getMap<unknown>(INK_KEY);
      ink.set('s2', blob(40, 2));
      ink.set('s1', blob(12, 1));
      ink.set('junk', 'not a stroke');
      ink.set('empty', new Uint8Array(0));
      doc.getMap(PAGE_FORMAT_KEY).set('version', 2);
    },
  },
  {
    name: 'bad-settings',
    about: 'Page settings with values the app does not know fall back to the defaults.',
    title: 'Bad settings',
    tasks: {},
    build: (doc) => {
      wideBox('b', [p('x')])(doc);
      const s = doc.getMap<unknown>('pageSettings');
      s.set('color', 'magenta');
      s.set('rules', 7);
    },
  },
  {
    name: 'geometry-defaults',
    about: 'Box geometry with broken or missing values (defaults: x 0, y 0, w 400, z 0) and plain-object entries.',
    title: 'Geometry',
    tasks: {},
    build: (doc) => {
      const boxes = doc.getMap<unknown>(BOXES_KEY);
      const m = new Y.Map<unknown>();
      m.set('x', 'ten');
      m.set('y', 50);
      m.set('wide', 'yes');
      boxes.set('strings', m);
      boxes.set('plain', { x: 5, y: 50, w: 320, z: 2, wide: true });
      boxes.set('nothing', new Y.Map());
      boxes.set('number', 42);
      write(doc, boxField('strings'), [p('Broken numbers')]);
      write(doc, boxField('plain'), [p('Plain object geometry')]);
      write(doc, boxField('nothing'), [p('No geometry at all')]);
      write(doc, boxField('number'), [p('Geometry is a number')]);
      write(doc, boxField('orphan'), [p('A fragment with no box entry is not page content')]);
    },
  },
  {
    name: 'newer-format',
    about: 'Written by a newer app: format version 99 and a block type this app does not know.',
    title: 'From the future',
    tasks: {},
    build: (doc) => {
      wideBox('b', [p('Known paragraph')])(doc);
      const el = new Y.XmlElement('futureBlock');
      el.setAttribute('kind', 'hologram');
      const inner = new Y.XmlElement('paragraph');
      inner.insert(0, [new Y.XmlText('Text inside an unknown block')]);
      el.insert(0, [inner]);
      doc.getXmlFragment(boxField('b')).insert(1, [el]);
      doc.getMap(PAGE_FORMAT_KEY).set('version', 99);
    },
  },
  {
    name: 'sanitize',
    about: 'Unsafe links, images, file cards and colours that sanitizeYDoc removes; safe ones it keeps.',
    title: 'Sanitize',
    tasks: {},
    build: wideBox('b', [
      p(t('js', ['link', { href: 'javascript:alert(1)' }]), ' ', t('split scheme', ['link', { href: 'java\nscript:alert(1)' }]), ' ', t('protocol relative', ['link', { href: '//evil.example' }]), ' ', t('backslash', ['link', { href: '/\\evil.example' }])),
      p(t('web', ['link', { href: 'https://ok.example' }]), ' ', t('mail', ['link', { href: 'mailto:a@b.c' }]), ' ', t('tel', ['link', { href: 'tel:+15551234' }]), ' ', t('path', ['link', { href: '/p/123' }]), ' ', t('anchor', ['link', { href: '#top' }]), ' ', t('deep', ['link', { href: 'notivelo://page/1' }]), ' ', t('data', ['link', { href: 'data:text/html,x' }])),
      p(t('hex colour', ['textStyle', { color: '#ff0000' }]), ' ', t('css highlight', ['highlight', { color: 'url(x)' }]), ' ', t('good', ['textStyle', { color: 'blue' }], ['highlight', { color: 'yellow' }])),
      node('image', { src: 'data:image/png;base64,AAAA' }),
      node('image', { src: 'https://ok.example/a b.png' }),
      node('image', { src: '/uploads/0123456789abcdef0123456789abcdef.png?s=0123456789abcdef0123456789abcdef&e=1' }),
      node('fileAttachment', { url: 'javascript:alert(1)', name: 'bad' }),
      node('fileAttachment', { url: 'https://ok.example/f.zip', name: 'good' }),
      node('callout', null, [node('image', { src: 'file:///etc/passwd' }), p(t('nested bad link', ['link', { href: 'vbscript:x' }]))]),
    ]),
  },
];
