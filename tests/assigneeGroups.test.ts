// People grouped by team for the Assignee filter and picker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupAssignees, tickState, toggleGroup } from '../src/lib/assigneeGroups.ts';
import type { Team } from '../shared/types.ts';

const team = (id: string, name: string, memberIds: string[], parentId: string | null = null, position = 0): Team => ({ id, workspaceId: 'w', parentId, name, color: '#888', position, memberIds });
const people = ['ann', 'bob', 'cy', 'dee', 'eli'].map((id) => ({ id, name: id[0]!.toUpperCase() + id.slice(1) }));

test('people are listed under their team, subteams nested, people in no team under "No team" at the bottom', () => {
  const teams = [team('eng', 'Eng', ['ann'], null, 0), team('plat', 'Platform', ['bob', 'cy'], 'eng', 0), team('design', 'Design', ['dee'], null, 1)];
  const { groups } = groupAssignees(teams, people);
  assert.deepEqual(groups.map((g) => [g.name, g.depth, g.direct]), [['Eng', 0, ['ann']], ['Platform', 1, ['bob', 'cy']], ['Design', 0, ['dee']], ['No team', 0, ['eli']]]);
  assert.deepEqual(groups[0]!.all, ['ann', 'bob', 'cy'], 'ticking Eng covers its subteam');
  assert.deepEqual(groups[1]!.all, ['bob', 'cy']);
});

test('a person in two teams appears under both, with both named in the search text', () => {
  const teams = [team('a', 'Alpha', ['ann', 'bob']), team('b', 'Beta', ['bob'], null, 1)];
  const { groups, teamsOf } = groupAssignees(teams, people.slice(0, 2));
  assert.deepEqual(groups.map((g) => g.direct), [['ann', 'bob'], ['bob']]);
  assert.deepEqual(teamsOf.get('bob'), ['Alpha', 'Beta']);
  assert.deepEqual(teamsOf.get('ann'), ['Alpha']);
});

test('a subteam person is named with the full "Team › Subteam" in the search text; empty teams and unknown ids are skipped', () => {
  const teams = [team('eng', 'Eng', [], null), team('plat', 'Platform', ['bob', 'ghost'], 'eng'), team('empty', 'Empty', [], null, 2)];
  const { groups, teamsOf } = groupAssignees(teams, people);
  assert.deepEqual(groups.map((g) => g.name), ['Eng', 'Platform', 'No team']);
  assert.deepEqual(groups[0]!.direct, [], 'Eng lists nobody itself but ticking it covers Platform');
  assert.deepEqual(groups[0]!.all, ['bob']);
  assert.deepEqual(teamsOf.get('bob'), ['Eng › Platform']);
});

test('a workspace with no teams gets one unnamed group (no heading)', () => {
  const { groups } = groupAssignees([], people);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.name, '');
  assert.equal(groups[0]!.all.length, 5);
});

test('ticking a heading: all, partial and none; clicking toggles every member, and keeps other ticks', () => {
  const all = ['ann', 'bob', 'cy'];
  assert.equal(tickState(all, []), 'none');
  assert.equal(tickState(all, ['bob']), 'some');
  assert.equal(tickState(all, ['cy', 'ann', 'bob', 'zed']), 'all');
  assert.deepEqual(toggleGroup(all, ['bob', 'zed']).sort(), ['ann', 'bob', 'cy', 'zed']);
  assert.deepEqual(toggleGroup(all, ['ann', 'bob', 'cy', 'zed']), ['zed']);
  // A person in two teams: ticking one team ticks them under the other too (same id).
  assert.equal(tickState(['bob'], toggleGroup(all, [])), 'all');
});
