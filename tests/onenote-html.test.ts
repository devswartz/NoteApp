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

test('positioned outlines become canvas boxes with their geometry; loose content goes in a box below', () => {
  const c = convertOneNotePage(`<html><head><title>P</title></head><body data-absolute-enabled="true" style="font-family:Calibri">
    <div data-id="_default" style="position:absolute;left:48px;top:115px;width:624px"><p>Left</p><p data-tag="to-do">Task</p></div>
    <div style="position: absolute; left: 700px; top: 40px; width: 300px"><p>Right, higher up</p></div>
    <img style="position:absolute;left:48px;top:600px;width:320px;height:200px" src="https://graph.microsoft.com/v1.0/me/onenote/resources/i/$value" data-src-type="image/png" />
    <div style="position:absolute;left:10px;top:10px"><p> </p></div>
    <p>Loose paragraph</p>
  </body></html>`);
  assert.equal(c.kind, 'canvas');
  // OneNote's coordinates start at the page's corner (title block included): the canvas starts at the layout, so
  // everything moves up by 40 (the topmost box) and left by 48 (the leftmost); the empty outline is dropped.
  assert.deepEqual(
    c.boxes.map(({ x, y, w, z }) => ({ x, y, w, z })),
    [
      { x: 0, y: 75, w: 624, z: 0 },
      { x: 652, y: 0, w: 300, z: 1 },
      { x: 0, y: 560, w: 320, z: 2 },
      { x: 0, y: 784, w: 624, z: 3 }, // below the image (560 + 200 + gap)
    ],
  );
  for (const b of c.boxes) schema.nodeFromJSON(b.doc).check();
  assert.deepEqual(c.boxes.map((b) => b.doc.content.map((n) => n.type)), [['paragraph', 'taskRef'], ['paragraph'], ['image'], ['paragraph']]);
  assert.deepEqual([c.resources.length, c.todos.length], [1, 1], 'resource and to-do keys are shared across boxes');
  // `doc` is every box in reading order (top to bottom, then left to right).
  assert.deepEqual(c.doc.content.map((n) => n.content?.[0]?.text ?? n.type), ['Right, higher up', 'Left', 'taskRef', 'image', 'Loose paragraph']);
});

// A page like the one Devon imported: a title, "Test High" top right just under the date line, "First line text" with a
// 4×4 table below it at the left, "Test Sideways" level with the first line and further right, and "4th" with a
// superscript in a table cell. OneNote reports positions from the page's corner, title block included.
const DEVON_PAGE = `<html><head><title>Import Note Test</title></head><body data-absolute-enabled="true" style="font-family:Calibri;font-size:11pt">
  <div data-id="high" style="position:absolute;left:480px;top:115px;width:192px"><p>Test High</p></div>
  <div data-id="first" style="position:absolute;left:48px;top:178px;width:240px"><p>First line text</p>
    <table border="1" style="border-collapse:collapse"><tr>
      <td style="width:60px"><p>&nbsp;</p></td><td style="width:60px"><p><br/></p></td><td style="width:60px"><p>4<sup>th</sup> line</p></td><td style="width:60px"><p>&nbsp;</p><p>&nbsp;</p></td></tr>
      <tr><td><p>&nbsp;</p></td><td><p>&nbsp;</p></td><td><p>&nbsp;</p></td><td><p>&nbsp;</p></td></tr>
    </table></div>
  <div data-id="side" style="position:absolute;left:330px;top:178px;width:200px"><p>Test Sideways</p></div>
</body></html>`;

test('a OneNote page is laid out from the canvas corner, as on the page: relative positions kept, the title block offset removed', () => {
  const c = valid(DEVON_PAGE);
  assert.equal(c.title, 'Import Note Test');
  assert.equal(c.kind, 'canvas');
  const at = (text: string) => c.boxes.find((b) => JSON.stringify(b.doc).includes(text))!;
  const [high, first, side] = [at('Test High'), at('First line text'), at('Test Sideways')];
  // The topmost box starts at the top of the canvas and the leftmost at its left edge (OneNote's 115 / 48 are gone).
  assert.equal(Math.min(...c.boxes.map((b) => b.y)), 0);
  assert.equal(Math.min(...c.boxes.map((b) => b.x)), 0);
  assert.ok(high.y <= 40, 'content starts within 40px of the canvas top');
  // As in OneNote: "Test High" is above the first line and to the right of "Test Sideways", which is level with it.
  assert.ok(high.y < first.y);
  assert.ok(high.x > side.x);
  assert.equal(first.y, side.y);
  assert.ok(side.x > first.x);
  assert.deepEqual([high.x - first.x, first.y - high.y, side.x - first.x], [432, 63, 282], 'distances between the outlines are OneNote’s, unscaled');
});

test('empty table cells are one empty line, not &nbsp; text or line breaks; cell widths are kept', () => {
  const c = valid(DEVON_PAGE);
  const table = c.boxes.find((b) => JSON.stringify(b.doc).includes('"table"'))!.doc.content.find((n) => n.type === 'table')!;
  const cells = table.content!.flatMap((r) => r.content!);
  const empties = cells.filter((cell) => !JSON.stringify(cell).includes('line'));
  assert.equal(empties.length, 7);
  for (const cell of empties) assert.deepEqual(cell.content, [{ type: 'paragraph' }], 'one empty paragraph');
  assert.deepEqual(cells[0].attrs?.colwidth, [60]);
  assert.equal(cells[4].attrs?.colwidth, null, 'no width given: none set');
});

test('superscript and subscript text is kept as text (the editor has no such mark)', () => {
  const c = valid(DEVON_PAGE);
  assert.match(JSON.stringify(c.boxes.map((b) => b.doc)), /"4th line"/);
});

test('a line break closing a paragraph is dropped; blank lines made of &nbsp; and <br> stay one empty line', () => {
  const c = valid(`<body><p>text<br/></p><p>&nbsp;</p><p><br/><br/></p><p>a<br/>b</p></body>`);
  assert.deepEqual(c.doc.content, [
    { type: 'paragraph', content: [{ type: 'text', text: 'text' }] },
    { type: 'paragraph' },
    { type: 'paragraph' },
    { type: 'paragraph', content: [{ type: 'text', text: 'a' }, { type: 'hardBreak' }, { type: 'text', text: 'b' }] },
  ]);
});

test('pages without positioned top-level elements stay documents', () => {
  const c = valid(`<body><div><p>a</p></div><div style="position:relative;left:5px"><p>b</p></div><div><div style="position:absolute;left:5px;top:5px"><p>nested</p></div></div></body>`);
  assert.equal(c.kind, 'document');
  assert.deepEqual(c.boxes, []);
  assert.deepEqual(c.doc.content.map((n) => n.content?.[0]?.text), ['a', 'b', 'nested']);
});

test('malformed, negative and huge geometry is clamped to sane values', () => {
  // A box at the corner anchors the origin, so the box under test keeps its own coordinates (they are moved to the corner otherwise).
  const box = (style: string, extra = '') => convertOneNotePage(`<body><div style="position:absolute;left:0;top:0"><p>anchor</p></div><div style="${style}" ${extra}><p>x</p></div></body>`).boxes[1];
  const g = (b: ReturnType<typeof box>) => [b.x, b.y, b.w];
  assert.deepEqual(g(box('position:absolute;left:-50px;top:1e308px;width:99999999999px')), [0, 48, 4000], 'exponent syntax is junk → default top');
  assert.deepEqual(g(box('position:absolute;left:999999999px;top:-1px;width:2px')), [50_000, 0, 40]);
  assert.deepEqual(g(box('position:absolute;left:abc;top:calc(1px + 2px);width:50%')), [48, 48, 624]);
  assert.deepEqual(g(box('POSITION:ABSOLUTE;LEFT:10.6PX;TOP:30pt;width:NaNpx;left:20px')), [20, 40, 624], 'case-insensitive, pt → px, later wins');
  assert.deepEqual(g(box('position:absolute', 'width="250"')), [48, 48, 250], 'width attribute as a fallback');
  assert.deepEqual(g(box(`position:absolute;${'x:y;'.repeat(1500)}left:7px`)), [48, 48, 624], 'only the first 4 KB of a style is read');
});

test('to-dos (open, completed,tagged with several tags, inside lists) become taskRef placeholders', () => {
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
    'positioned outlines': (n) => '<body>' + fill('<div style="position:absolute;left:9px;top:9px;width:9px"><p>x</p></div>', n),
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
    // quadruples it when it is quadratic. Timings under ~50 ms are too noisy to compare.
    if (half > 50) assert.ok(full < 3 * half, `${name}: ${Math.round(half)} ms at 512 KB → ${Math.round(full)} ms at 1 MB`);
    assert.ok(full < 2000, `${name}: ${Math.round(full)} ms`);
  }
  // Deeper than MAX_DEPTH: flattened, the text survives.
  const deep = convertOneNotePage(`<body>${'<div>'.repeat(5000)}<p>bottom</p>${'</div>'.repeat(5000)}</body>`);
  assert.match(JSON.stringify(deep.doc), /bottom/);
});
