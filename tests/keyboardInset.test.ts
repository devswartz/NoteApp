// How much room the page still has to make for the keyboard (src/platform/keyboardInset.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyboardInset } from '../src/platform/keyboardInset.ts';

test('a web view that shrank by the keyboard needs no more room (resize: native: the squashed page)', () => {
  // iPhone: 664px tall, keyboard 336px, the web view is now 328px tall: nothing left to add.
  assert.equal(keyboardInset(336, 664, 328), 0);
});

test('a web view that did not shrink needs the whole keyboard', () => {
  assert.equal(keyboardInset(336, 664, 664), 336);
});

test('a web view that shrank part of the way needs the rest', () => {
  assert.equal(keyboardInset(336, 664, 500), 172);
});

test('shrinking by more than the keyboard, or growing, never gives a negative inset', () => {
  assert.equal(keyboardInset(300, 664, 300), 0);
  assert.equal(keyboardInset(300, 600, 700), 300);
  assert.equal(keyboardInset(0, 664, 664), 0);
});
