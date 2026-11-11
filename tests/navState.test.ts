// Rail views, the Notes selection and F6 region order (src/components/shell/navState.ts, useF6Regions.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { childSections, resolveSelection, viewOf } from '../src/components/shell/navRules.ts';
import { nextRegion } from '../src/components/shell/useF6Regions.ts';
import type { Tree } from '../shared/types.ts';

const nb = (id: string, createdBy: string, position: number) => ({ id, workspaceId: 'w', name: id, color: '#000', visibility: 'shared' as const, createdBy, position });
const sec = (id: string, notebookId: string, position: number, parentId?: string) => ({ id, notebookId, name: id, color: '#000', position, parentId: parentId ?? null });
const page = (id: string, sectionId: string) => ({ id, sectionId, title: id, icon: null, kind: 'document' as const, position: 1, updatedAt: '', updatedBy: null });
const tree: Tree = {
  notebooks: [nb('theirs', 'u2', 0), nb('mine', 'me', 1)],
  sections: [sec('s2', 'mine', 2), sec('s1', 'mine', 1), sec('sub', 'mine', 1, 's1'), sec('t1', 'theirs', 1)],
  pages: [page('p1', 's2'), page('p2', 'sub')],
};
const q = (s = '') => new URLSearchParams(s);

test('viewOf maps routes to rail views', () => {
  assert.equal(viewOf('/w/a/p/x'), 'notes');
  assert.equal(viewOf('/w/a/notes'), 'notes');
  assert.equal(viewOf('/w/a/tasks/today'), 'tasks');
  assert.equal(viewOf('/w/a/tasks/calendar'), 'calendar');
  assert.equal(viewOf('/w/a/settings'), null);
});

test('childSections: top level and nested (parentId is optional)', () => {
  assert.deepEqual(childSections(tree, 'mine', null).map((s) => s.id), ['s1', 's2']);
  assert.deepEqual(childSections(tree, 'mine', 's1').map((s) => s.id), ['sub']);
});

test('selection follows the open page, including a page in a subsection', () => {
  assert.deepEqual(resolveSelection(tree, 'me', '/w/a/p/p2', q(), undefined, {}), { notebookId: 'mine', sectionId: 'sub', pageId: 'p2' });
});

test('selection from /notes?sec=, then stored, then my first notebook', () => {
  assert.equal(resolveSelection(tree, 'me', '/w/a/notes', q('sec=t1'), undefined, {}).sectionId, 't1');
  assert.equal(resolveSelection(tree, 'me', '/w/a/notes', q(), { sec: 's2' }, {}).sectionId, 's2');
  const first = resolveSelection(tree, 'me', '/w/a/tasks/today', q(), undefined, {});
  assert.deepEqual([first.notebookId, first.sectionId], ['mine', 's1']);
  assert.equal(resolveSelection(tree, 'me', '/w/a/notes', q(), { nb: 'mine' }, { mine: 's2' }).sectionId, 's2');
  // The phone's notebook screen selects a notebook without a section.
  assert.equal(resolveSelection(tree, 'me', '/w/a/notes', q('nb=theirs'), undefined, {}).sectionId, null);
});

test('F6 cycles through regions both ways', () => {
  assert.equal(nextRegion(4, -1, false), 0);
  assert.equal(nextRegion(4, 3, false), 0);
  assert.equal(nextRegion(4, 0, true), 3);
  assert.equal(nextRegion(0, 0, false), -1);
});
