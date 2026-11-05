import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { presenceFrom, samePresence } from '../src/editor/collab.ts';

function peer(user: object) {
  const a = new Awareness(new Y.Doc());
  a.setLocalStateField('user', user);
  return a;
}

test('presenceFrom: one entry per person, excludes me and my other tabs, sorted, viewer flag', () => {
  const me = new Awareness(new Y.Doc());
  me.setLocalStateField('user', { id: 'me', name: 'Me', color: '#111111' });
  const peers = [
    peer({ id: 'me', name: 'Me', color: '#111111' }), // my other tab
    peer({ id: 'b', name: 'Bea', color: '#222222', canEdit: false }),
    peer({ id: 'a', name: 'Al', color: '#333333' }),
    peer({ id: 'a', name: 'Al', color: '#333333' }), // Al's second tab
    new Awareness(new Y.Doc()), // a client that hasn't announced itself yet
  ];
  for (const p of peers) applyAwarenessUpdate(me, encodeAwarenessUpdate(p, [p.clientID]), 'remote');
  const list = presenceFrom(me, 'me');
  assert.deepEqual(list, [
    { id: 'a', name: 'Al', color: '#333333', canEdit: true, sessions: 2 },
    { id: 'b', name: 'Bea', color: '#222222', canEdit: false, sessions: 1 },
  ]);
  assert.ok(samePresence(list, presenceFrom(me, 'me')));
  assert.ok(!samePresence(list, list.slice(1)));
  for (const a of [me, ...peers]) a.destroy(); // Awareness runs a timer
});
