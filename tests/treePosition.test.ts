import { test } from 'node:test';
import assert from 'node:assert/strict';
import { positionAt } from '../src/components/shell/treePosition.ts';

// Must agree with server/tree.ts positionAt so optimistic moves match the server's order.
test('positionAt: empty, start, end, between', () => {
  const sibs = [{ position: 1 }, { position: 2 }, { position: 4 }];
  assert.equal(positionAt([], 0), 1);
  assert.equal(positionAt(sibs, 0), 0);
  assert.equal(positionAt(sibs, 1), 1.5);
  assert.equal(positionAt(sibs, 2), 3);
  assert.equal(positionAt(sibs, 3), 5);
  assert.equal(positionAt(sibs, Infinity), 5);
});
