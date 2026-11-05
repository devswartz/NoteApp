// Pure editor helpers (no DOM needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { normaliseUrl } = await import('../src/editor/LinkEditor.tsx');
const { filterSlash, SLASH_ITEMS } = await import('../src/editor/SlashMenu.tsx');

test('normaliseUrl adds https, recognises email, refuses script URLs', () => {
  assert.equal(normaliseUrl('example.com'), 'https://example.com');
  assert.equal(normaliseUrl('  https://a.b/c?d=1 '), 'https://a.b/c?d=1');
  assert.equal(normaliseUrl('http://x.y'), 'http://x.y');
  assert.equal(normaliseUrl('sam@example.com'), 'mailto:sam@example.com');
  assert.equal(normaliseUrl('mailto:a@b.c'), 'mailto:a@b.c');
  assert.equal(normaliseUrl('/w/1/p/2'), '/w/1/p/2');
  assert.equal(normaliseUrl('noteapp://page/abc'), 'noteapp://page/abc');
  assert.equal(normaliseUrl('javascript:alert(1)'), null);
  assert.equal(normaliseUrl('JavaScript:alert(1)'), null);
  assert.equal(normaliseUrl('data:text/html,x'), null);
  assert.equal(normaliseUrl('   '), null);
});

test('slash menu ranks title prefixes first and matches keywords', () => {
  assert.equal(filterSlash('').length, SLASH_ITEMS.length);
  assert.equal(filterSlash('h2')[0].title, 'Heading 2');
  assert.equal(filterSlash('call')[0].title, 'Callout');
  assert.equal(filterSlash('collapse')[0].title, 'Toggle');
  assert.equal(filterSlash('todo')[0].title, 'Task');
  assert.equal(filterSlash('code')[0].title, 'Code block');
  assert.ok(filterSlash('pdf').some((i) => i.title === 'File attachment'));
  assert.deepEqual(filterSlash('zzzz'), []);
});

test('[[ page suggestions: prefix first, current page excluded, "Create" when no exact match', async () => {
  const { pageItems } = await import('../src/editor/pageItems.ts');
  const pg = (id: string, title: string, updatedAt = '2026-01-01') => ({ id, sectionId: 's', title, icon: null, kind: 'document' as const, position: 1, updatedAt, updatedBy: null });
  const tree = {
    notebooks: [{ id: 'n', workspaceId: 'w', name: 'Work', color: '', visibility: 'shared' as const, createdBy: 'u', position: 1 }],
    sections: [{ id: 's', notebookId: 'n', name: 'Notes', color: '', position: 1 }],
    pages: [pg('1', 'Project plan'), pg('2', 'Plan B'), pg('3', 'Roadmap'), pg('4', 'Current')],
  };
  const items = pageItems('plan', '4', tree);
  assert.deepEqual(items.map((i) => (i.kind === 'page' ? i.page.title : `+${i.title}`)), ['Plan B', 'Project plan', '+plan']);
  assert.equal(items[0].kind === 'page' && items[0].crumb, 'Work › Notes');
  assert.ok(!pageItems('', '4', tree).some((i) => i.kind === 'page' && i.page.id === '4'));
  assert.ok(!pageItems('roadmap', '4', tree).some((i) => i.kind === 'create'));
});

test('safeFileUrl allows upload paths and http(s) only', async () => {
  const { safeFileUrl } = await import('../src/editor/urls.ts');
  assert.equal(safeFileUrl('/uploads/0123456789abcdef0123456789abcdef.pdf'), '/uploads/0123456789abcdef0123456789abcdef.pdf');
  assert.equal(safeFileUrl('https://example.com/a.pdf'), 'https://example.com/a.pdf');
  for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,x', '//evil.com/x', '/uploads/../../x', '/api/me', 'https://a b', 42, null]) {
    assert.equal(safeFileUrl(bad), '', String(bad));
  }
});

test('templates: titles use the date, content uses only known node types', async () => {
  const { TEMPLATES, templateById } = await import('../src/editor/templates.ts');
  const known = new Set(['paragraph', 'text', 'heading', 'bulletList', 'orderedList', 'listItem', 'taskList', 'taskItem', 'callout', 'table', 'tableRow', 'tableHeader', 'tableCell', 'details', 'detailsSummary', 'detailsContent']);
  const d = new Date(2026, 10, 5);
  assert.deepEqual(TEMPLATES.map((t) => t.id), ['meeting', 'project', 'journal']);
  assert.match(templateById('journal')!.title(d), /2026/);
  assert.match(templateById('meeting')!.title(d), /^Meeting · /);
  type J = { type?: string; content?: J[] };
  const walk = (n: J): string[] => [n.type ?? '', ...(n.content ?? []).flatMap(walk)];
  for (const t of TEMPLATES) for (const type of t.content(d).flatMap(walk)) assert.ok(known.has(type), `${t.id}: ${type}`);
});

test('markdown import/export helpers: title split and safe file names', async () => {
  const { splitTitle, fileName } = await import('../src/editor/markdownUtils.ts');
  assert.deepEqual(splitTitle('# Trip plan\n\nPack bags'), { title: 'Trip plan', body: 'Pack bags' });
  assert.deepEqual(splitTitle('﻿# Notes ##\r\n- a\r\n'), { title: 'Notes', body: '- a\n' });
  assert.deepEqual(splitTitle('Just text\n# Later heading'), { title: null, body: 'Just text\n# Later heading' });
  assert.equal(splitTitle('## Sub only\nx').title, null);
  assert.equal(fileName('Q3: plan / budget?', 'md'), 'Q3 plan budget.md');
  assert.equal(fileName('   ', 'md'), 'Untitled.md');
  assert.equal(fileName('Welcome 👋', 'md'), 'Welcome.md');
  assert.equal(fileName('🎯', 'md'), 'Untitled.md');
});

test('link and image URL checks, and sanitizeContent for imported/exported documents', async () => {
  const { safeLinkUrl, safeImageUrl, sanitizeContent } = await import('../src/editor/urls.ts');
  for (const ok of ['https://a.b/c', 'http://x', 'mailto:a@b.c', 'tel:+1', 'noteapp://page/1', '/w/1/p/2', '#top']) assert.equal(safeLinkUrl(ok), ok, ok);
  for (const bad of ['javascript:alert(1)', ' JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', 'java\nscript:x', 'data:text/html,x', 'vbscript:x', 'file:///etc/passwd', '//evil.com', 42]) {
    assert.equal(safeLinkUrl(bad), '', String(bad));
  }
  assert.equal(safeImageUrl('/uploads/abc.png'), '/uploads/abc.png');
  assert.equal(safeImageUrl('https://x.y/a.png'), 'https://x.y/a.png');
  for (const bad of ['data:image/svg+xml,<svg onload=alert(1)>', 'javascript:x', '/api/me', '//x.y/a.png']) assert.equal(safeImageUrl(bad), '', bad);

  const doc = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [
        { type: 'text', text: 'bad', marks: [{ type: 'bold' }, { type: 'link', attrs: { href: 'javascript:alert(1)' } }] },
        { type: 'text', text: 'good', marks: [{ type: 'link', attrs: { href: 'https://ok.example' } }] },
      ] },
      { type: 'image', attrs: { src: 'data:image/png;base64,AAA' } },
      { type: 'image', attrs: { src: '/uploads/abc.png' } },
      { type: 'fileAttachment', attrs: { url: 'javascript:x', name: 'x' } },
    ],
  };
  const out = sanitizeContent(doc);
  const para = out.content![0].content!;
  assert.deepEqual(para[0].marks, [{ type: 'bold' }], 'unsafe link mark dropped, text and other marks kept');
  assert.equal(para[1].marks![0].attrs!.href, 'https://ok.example');
  assert.deepEqual(out.content!.slice(1).map((n) => n.attrs!.src ?? n.type), ['/uploads/abc.png']);
});

test('backslash tricks are protocol-relative links and are rejected', async () => {
  const { safeLinkUrl, safeImageUrl } = await import('../src/editor/urls.ts');
  for (const bad of ['/\\evil.example', '\\\\evil.example', '\\/evil.example', '/\\/evil.example', ' /\t\\evil.example']) {
    assert.equal(safeLinkUrl(bad), '', JSON.stringify(bad));
    assert.equal(safeImageUrl(bad), '', JSON.stringify(bad));
  }
  assert.equal(safeLinkUrl('/w/1/p/2'), '/w/1/p/2');
});

test('liftInlineImages splits text blocks around images, at any depth', async () => {
  const { liftInlineImages } = await import('../src/editor/markdownUtils.ts');
  const img = (src: string) => ({ type: 'image', attrs: { src } });
  const t = (text: string) => ({ type: 'text', text });
  const doc = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [t('See '), img('a.png'), t(' here')] },
      { type: 'paragraph', content: [img('b.png')] },
      { type: 'paragraph', content: [t('plain')] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [img('c.png'), t('  ')] }] }] },
    ],
  };
  const out = liftInlineImages(doc);
  const shape = (n: { type?: string; content?: unknown[]; attrs?: { src?: string } }): unknown =>
    n.type === 'image' ? `img:${n.attrs!.src}` : n.type === 'text' ? (n as { text: string }).text : { [n.type!]: (n.content ?? []).map((c) => shape(c as never)) };
  assert.deepEqual(out.content!.map((n) => shape(n as never)), [
    { paragraph: ['See '] },
    'img:a.png',
    { paragraph: [' here'] },
    'img:b.png',
    { paragraph: ['plain'] },
    { bulletList: [{ listItem: [{ paragraph: [] }, 'img:c.png'] }] },
  ]);
});
