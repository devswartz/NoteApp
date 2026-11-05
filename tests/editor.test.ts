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
