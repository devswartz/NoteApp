import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDeepLink } from '../src/platform/deepLinks.ts';

test('deep links: custom scheme page links', () => {
  assert.deepEqual(parseDeepLink('noteapp://page/abc-123'), { kind: 'page', pageId: 'abc-123' });
  assert.deepEqual(parseDeepLink('renamed://page/abc'), { kind: 'page', pageId: 'abc' });
});

test('deep links: in-app paths and universal links', () => {
  assert.deepEqual(parseDeepLink('noteapp://w/ws1/p/pg1?task=t1'), { kind: 'path', path: '/w/ws1/p/pg1?task=t1' });
  assert.deepEqual(parseDeepLink('https://notes.example.com/w/ws1/tasks/today'), { kind: 'path', path: '/w/ws1/tasks/today' });
  assert.deepEqual(parseDeepLink('noteapp://'), { kind: 'path', path: '/' });
});

test('deep links: unknown or malformed links are ignored', () => {
  assert.equal(parseDeepLink('not a url'), null);
  assert.equal(parseDeepLink('noteapp://settings/../../etc'), null);
  assert.equal(parseDeepLink('https://example.com/admin'), null);
});
