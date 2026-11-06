// OneNote HTML → editor JSON (server/onenoteHtml.ts): the output must be valid in the client editor's schema,
// and nothing executable may come through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema, Node } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import ImageExt from '@tiptap/extension-image';
import { convertOneNotePage, parseHtml, textOf } from '../server/onenoteHtml.ts';
import { sanitizeContent } from '../shared/urls.ts';

// The editor's schema (src/editor/NoteEditor.tsx → documentExtensions), with its React-only nodes as atom stand-ins.
const atom = (name: string, attrs: string[]) => Node.create({ name, group: 'block', atom: true, addAttributes: () => Object.fromEntries(attrs.map((a) => [a, { default: null }])) });
const schema = getSchema([StarterKit.configure({ heading: { levels: [1, 2, 3] } }), TableKit, ImageExt, atom('taskRef', ['taskId']), atom('fileAttachment', ['url', 'name', 'size', 'mime'])]);
const valid = (html: string) => {
  const c = convertOneNotePage(html);
  schema.nodeFromJSON(c.doc).check();
  return c;
};

test('headings, marks, lists, nested lists, tables and breaks produce a valid editor document', () => {
  const c = valid(`<html><head><title>T &amp; t</title></head><body><div style="position:absolute">
    <h1>One</h1><h4>Four → three</h4>
    <p>a <span style="font-weight:bold;font-style:italic">b</span> <u>c</u> <s>d</s> <a href="https://x.example">e</a><br/>f</p>
    <ul><li>one<ul><li>nested</li></ul></li><li><p>para in li</p></li></ul>
    <ol><li>x</li></ol>
    <table><tbody><tr><th>h</th><td colspan="2"><ul><li>in cell</li></ul></td></tr><tr><td></td></tr></tbody></table>
    <pre>code\n  block</pre><hr/><blockquote>q</blockquote><p></p></div></body></html>`);
  assert.equal(c.title, 'T & t');
  const types = JSON.stringify(c.doc);
  for (const t of ['heading', 'bulletList', 'orderedList', 'table', 'tableHeader', 'codeBlock', 'horizontalRule', 'blockquote', 'hardBreak', 'underline', 'strike', 'link']) assert.ok(types.includes(`"${t}"`), t);
  assert.equal(c.doc.content[1].attrs?.level, 3, 'h4+ become level 3');
});

test('to-dos (open, completed, tagged with several tags, inside lists) become taskRef placeholders', () => {
  const c = valid(`<body><p data-tag="to-do">Open one</p><p data-tag="to-do:completed">Done one</p>
    <ul><li>before</li><li data-tag="important,to-do">In a list</li><li>after</li></ul><p data-tag="important">not a to-do</p></body>`);
  assert.deepEqual(c.todos.map((t) => [t.title, t.done]), [['Open one', false], ['Done one', true], ['In a list', false]]);
  // The list is split around the to-do (a taskRef can't open a list item).
  assert.deepEqual(c.doc.content.map((n) => n.type), ['taskRef', 'taskRef', 'bulletList', 'taskRef', 'bulletList', 'paragraph']);
});

test('images and attachments are hoisted out of paragraphs as resources', () => {
  const c = valid(`<body><p>before <img src="https://graph.microsoft.com/v1.0/me/onenote/resources/a/$value" data-src-type="image/png" data-fullres-src="https://graph.microsoft.com/v1.0/me/onenote/resources/full/$value" data-fullres-src-type="image/jpeg" alt="pic"/> after</p>
    <object data-attachment="r.pdf" type="application/pdf" data="https://graph.microsoft.com/v1.0/me/onenote/resources/b/$value"/></body>`);
  assert.deepEqual(c.doc.content.map((n) => n.type), ['paragraph', 'image', 'paragraph', 'fileAttachment']);
  assert.deepEqual(c.resources.map((r) => [r.kind, r.url.split('/').at(-2), r.type, r.name]), [['image', 'full', 'image/jpeg', 'image'], ['file', 'b', 'application/pdf', 'r.pdf']]);
});

test('malicious HTML: scripts, styles, iframes, forms and handlers are never read; unsafe links are dropped by sanitizeContent', () => {
  const c = valid(`<body onload="x()"><script>alert(1)</script><style>p{}</style><p onclick="y()">hi <a href="javascript:alert(2)">bad</a> <a href="java&#x09;script:z()">bad2</a></p>
    <img src="x" onerror="alert(3)"/><iframe><p>framed</p></iframe><svg><script>s()</script></svg><form><input value="pw"/></form><p>a < b and <unclosed</p></body>`);
  const clean = JSON.stringify(sanitizeContent(c.doc));
  assert.doesNotMatch(clean, /alert|script|onclick|onerror|onload|framed|pw/i);
  assert.match(clean, /"text":"bad"/);
  assert.ok(!clean.includes('"link"'), 'unsafe links lose the link mark');
});

test('the parser tolerates broken markup and decodes entities', () => {
  assert.equal(textOf(parseHtml('<p>a &amp; b &#x1F600; &#65; &bogus; <b>bold<i>both</b> tail')), 'a & b 😀 A &bogus; boldboth tail');
  assert.doesNotThrow(() => convertOneNotePage('<<<>>><p></div></li><td>'.repeat(1000)));
  const t0 = Date.now();
  convertOneNotePage('<a' + ' x'.repeat(200_000));
  assert.ok(Date.now() - t0 < 2000, 'no catastrophic backtracking');
});

test('pathological 1 MB pages convert in linear time (no quadratic parsing, nesting capped)', () => {
  const MB = 1024 * 1024;
  const fill = (unit: string, size: number) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
  const cases: Record<string, (size: number) => string> = {
    'unmatched close tags': (n) => fill('<b>', n / 2) + fill('</i>', n / 2),
    'deep nesting': (n) => fill('<b><i>', n / 2) + fill('</b>', n / 2),
    'implied ends': (n) => fill('<li><td><p>x', n),
    'unclosed tags': (n) => fill('<a ', n),
    'long tag names': (n) => '<' + fill('a', n),
    'stray brackets': (n) => fill('< <! <? </ <a', n),
    'comments': (n) => fill('<!-- x --><!--', n),
    'many titles': (n) => fill('<title', n),
    'entities': (n) => fill('&aaaaaaaa', n),
    'tables': (n) => fill('<table><tr><td>', n),
  };
  // Fastest of two runs, to skip one-off GC pauses and JIT warm-up.
  const time = (html: string) =>
    Math.min(
      ...[0, 1].map(() => {
        const t0 = performance.now();
        convertOneNotePage(html);
        return performance.now() - t0;
      }),
    );
  for (const [name, make] of Object.entries(cases)) {
    const half = time(make(MB / 2));
    const full = time(make(MB));
    // A fixed budget alone is flaky on slow or busy CI machines (one case takes
    // ~0.3 s locally and ~1 s on a GitHub runner), so the main check is growth:
    // doubling the input about doubles the time when parsing is linear and
    // quadruples it when it is quadratic. Sub-20 ms timings are too noisy to compare.
    if (full > 20) assert.ok(full < 3 * half, `${name}: ${Math.round(half)} ms at 512 KB → ${Math.round(full)} ms at 1 MB`);
    assert.ok(full < 2000, `${name}: ${Math.round(full)} ms`);
  }
  // Deeper than MAX_DEPTH: flattened, the text survives.
  const deep = convertOneNotePage(`<body>${'<div>'.repeat(5000)}<p>bottom</p>${'</div>'.repeat(5000)}</body>`);
  assert.match(JSON.stringify(deep.doc), /bottom/);
});
