import { test } from 'node:test';
import assert from 'node:assert/strict';
import { menuTarget, trapTarget } from '../src/components/focusNav.ts';

test('focus trap wraps at both ends and from the container itself', () => {
  assert.equal(trapTarget(3, 2, false), 0); // Tab on the last → first
  assert.equal(trapTarget(3, 0, true), 2); // Shift+Tab on the first → last
  assert.equal(trapTarget(3, -1, true), 2); // Shift+Tab from the container → last
  assert.equal(trapTarget(3, -1, false), 0);
  assert.equal(trapTarget(3, 1, false), null); // middle: browser default
  assert.equal(trapTarget(0, -1, true), null);
});

test('menu keys: arrows wrap, Home/End jump, other keys ignored', () => {
  assert.equal(menuTarget('ArrowDown', 4, -1), 0);
  assert.equal(menuTarget('ArrowDown', 4, 3), 0);
  assert.equal(menuTarget('ArrowUp', 4, 0), 3);
  assert.equal(menuTarget('ArrowUp', 4, -1), 3);
  assert.equal(menuTarget('Home', 4, 2), 0);
  assert.equal(menuTarget('End', 4, 1), 3);
  assert.equal(menuTarget('a', 4, 1), null);
  assert.equal(menuTarget('ArrowDown', 0, -1), null);
});
