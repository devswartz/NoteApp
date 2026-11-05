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
