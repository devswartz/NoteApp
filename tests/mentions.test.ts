import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchMembers } from '../src/editor/collabMentionMatch.ts';
import type { Member } from '../shared/types.ts';

const m = (name: string, email: string): Member => ({ id: name, name, email, color: '#000000', role: 'member' });
const people = [m('Sam Lee', 'sam@x.com'), m('Samantha Fox', 'sf@x.com'), m('Ada Sampson', 'ada@x.com'), m('Bo', 'bo@x.com')];

test('matchMembers: prefix of name first, then word prefix, then substring/email; limit', () => {
  assert.deepEqual(matchMembers(people, 'sam').map((x) => x.name), ['Sam Lee', 'Samantha Fox', 'Ada Sampson']);
  assert.deepEqual(matchMembers(people, 'lee').map((x) => x.name), ['Sam Lee']);
  assert.deepEqual(matchMembers(people, 'bo@').map((x) => x.name), ['Bo']);
  assert.equal(matchMembers(people, '').length, 4);
  assert.equal(matchMembers(people, '', 2).length, 2);
  assert.deepEqual(matchMembers(people, 'zz'), []);
});
