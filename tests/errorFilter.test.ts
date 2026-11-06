// Client error reporting decisions (src/lib/errorFilter.ts): ignore list, throttle, de-duplication.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createThrottle, dedupeKey, describeThrown, shouldIgnore, stripUrl } from '../src/lib/errorFilter.ts';

const err = (message: string, extra: Record<string, unknown> = {}) => ({ kind: 'error' as const, message, ...extra });

test('ignores ResizeObserver noise, opaque cross-origin errors, aborts, network failures and extension code', () => {
  assert.equal(shouldIgnore(err('ResizeObserver loop limit exceeded')), true);
  assert.equal(shouldIgnore(err('ResizeObserver loop completed with undelivered notifications.')), true);
  assert.equal(shouldIgnore(err('Script error.')), true);
  assert.equal(shouldIgnore(err('')), true);
  assert.equal(shouldIgnore(err('The operation was aborted.', { kind: 'unhandledrejection' })), true);
  assert.equal(shouldIgnore(err('x', { name: 'AbortError' })), true);
  assert.equal(shouldIgnore(err('Failed to fetch', { kind: 'unhandledrejection' })), true);
  assert.equal(shouldIgnore(err('boom', { source: 'chrome-extension://abcdef/content.js' })), true);
  assert.equal(shouldIgnore(err('boom', { stack: 'Error: boom\n at x (moz-extension://1234/a.js:1:1)' })), true);
});

test('reports real errors, including "Script error." that has a stack', () => {
  assert.equal(shouldIgnore(err('Cannot read properties of undefined (reading "id")', { stack: 'TypeError...\n at a (https://app/assets/x.js:1:1)' })), false);
  assert.equal(shouldIgnore(err('Script error.', { stack: 'Error\n at x' })), false);
  assert.equal(shouldIgnore({ kind: 'react', message: 'Minified React error #310' }), false);
});

test('throttle: at most 5 per minute, then allowed again as the window slides', () => {
  let t = 0;
  const th = createThrottle({ now: () => t });
  for (let i = 0; i < 5; i++) assert.equal(th.allow({ message: `e${i}` }), true);
  assert.equal(th.allow({ message: 'e5' }), false);
  t = 59_999;
  assert.equal(th.allow({ message: 'e6' }), false);
  t = 60_000;
  assert.equal(th.allow({ message: 'e7' }), true);
});

test('de-duplicates identical message+stack within a minute, without using budget', () => {
  let t = 0;
  const th = createThrottle({ now: () => t });
  const e = { message: 'same', stack: 'a\nb' };
  assert.equal(th.allow(e), true);
  for (let i = 0; i < 20; i++) assert.equal(th.allow({ ...e }), false);
  // duplicates did not consume budget: three other errors still fit
  for (let i = 0; i < 3; i++) assert.equal(th.allow({ message: `o${i}` }), true);
  assert.equal(th.allow({ message: 'same', stack: 'different' }), true); // same message, different stack: distinct
  t = 60_001;
  assert.equal(th.allow(e), true); // reportable again after the window
});

test('dedupeKey uses the message and the top of the stack', () => {
  assert.equal(dedupeKey({ message: 'm', stack: '1\n2\n3\n4\n5\n6\n7' }), dedupeKey({ message: 'm', stack: '1\n2\n3\n4\n5\n6\nOTHER' }));
  assert.notEqual(dedupeKey({ message: 'm' }), dedupeKey({ message: 'n' }));
});

test('stripUrl drops query string and fragment', () => {
  assert.equal(stripUrl('https://a.b/c/d?token=1&x=2#h'), 'https://a.b/c/d');
  assert.equal(stripUrl('https://a.b/c#h?x'), 'https://a.b/c');
  assert.equal(stripUrl('https://a.b/'), 'https://a.b/');
});

test('describeThrown copes with Errors, strings, objects, null and hostile values', () => {
  const e = new TypeError('bad');
  assert.deepEqual({ ...describeThrown(e), stack: undefined }, { message: 'bad', name: 'TypeError', stack: undefined });
  assert.equal(describeThrown('text').message, 'text');
  assert.equal(describeThrown({ a: 1 }).message, '{"a":1}');
  assert.equal(describeThrown(null).message, 'null');
  assert.equal(describeThrown(undefined).message, 'undefined');
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(typeof describeThrown(circular).message, 'string');
  const hostile = { get message(): string { throw new Error('nope'); } };
  assert.equal(describeThrown(hostile).message, 'Unknown error');
});
