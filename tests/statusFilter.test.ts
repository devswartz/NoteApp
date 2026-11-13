// The Status filter (Open / Completed / All) and the saved-view migration for views saved before it existed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_FILTERS, VIEWS, activeFilterKeys, applyFilters, byCompletion, migrateFilters, sameFilters } from '../src/lib/taskViews.ts';
import type { Task, Tree } from '../shared/types.ts';

const ME = 'me';
let seq = 0;
function task(p: Partial<Task> = {}): Task {
  const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, seq++)).toISOString();
  return {
    id: `t${seq}`, workspaceId: 'w', title: `Task ${seq}`, description: '', status: 'open', priority: 4,
    dueDate: null, dueTime: null, recurrence: null, reminderAt: null, assigneeId: ME, createdBy: ME,
    pageId: null, parentId: null, teamId: null, tagIds: [], assignedBy: null, completedAt: null, completedBy: null, createdAt: ts, updatedAt: ts, ...p,
  };
}
const tree: Tree = { notebooks: [], sections: [], pages: [] };

test('Status filter: Open (default), Completed, All, and the active-filter list', () => {
  const open = task({ title: 'Still to do' });
  const done = task({ title: 'Finished', status: 'done', completedAt: '2026-01-02T10:00:00.000Z' });
  const run = (status: 'open' | 'done' | 'any') => applyFilters([open, done], { ...DEFAULT_FILTERS, status }, ME, tree).map((t) => t.id);
  assert.deepEqual(run('open'), [open.id]);
  assert.deepEqual(run('done'), [done.id]);
  assert.deepEqual(run('any'), [open.id, done.id]);
  assert.equal(DEFAULT_FILTERS.status, 'open');
  assert.deepEqual(activeFilterKeys(DEFAULT_FILTERS), [], 'Open is the default: nothing to show or clear');
  assert.deepEqual(activeFilterKeys({ ...DEFAULT_FILTERS, status: 'done' }), ['status']);
  assert.deepEqual(activeFilterKeys({ ...DEFAULT_FILTERS, status: 'any' }), ['status']);
  assert.equal(sameFilters(DEFAULT_FILTERS, { ...DEFAULT_FILTERS, status: 'any' }), false);
});

test('Status filter: Completed lists newest completion first', () => {
  const a = task({ status: 'done', completedAt: '2026-01-01T10:00:00.000Z' });
  const b = task({ status: 'done', completedAt: '2026-01-03T10:00:00.000Z' });
  const c = task({ status: 'done', completedAt: '2026-01-02T10:00:00.000Z' });
  assert.deepEqual([a, b, c].sort(byCompletion).map((t) => t.id), [b.id, c.id, a.id]);
});

test('saved views: Status is stored; older views without it open as Open, or Completed if based on the old Completed view', async () => {
  const pk = (v: string) => ({ values: [v], not: false });
  assert.equal(migrateFilters({ priority: pk('1') }).status, 'open');
  assert.equal(migrateFilters(undefined).status, 'open');
  assert.equal(migrateFilters(null).status, 'open');
  assert.equal(migrateFilters({ status: 'any' }).status, 'any');
  assert.equal(migrateFilters({ status: 'done' }).status, 'done');
  assert.equal(migrateFilters({ status: 'bogus' }).status, 'open');
  assert.equal(migrateFilters({ priority: pk('1') }, 'completed').status, 'done');
  assert.equal(migrateFilters({ view: 'completed' }).status, 'done');
  assert.equal(migrateFilters({ status: 'any', view: 'completed' }).status, 'any', 'a stored Status wins');
  assert.equal(migrateFilters({}, 'today').status, 'open');
  const { parseSavedViews } = await import('../src/pages/tasks/savedViewsCore.ts');
  const [a, b, c, d] = parseSavedViews(
    JSON.stringify([
      { id: 'a', name: 'Old', filters: { priority: '1' } },
      { id: 'b', name: 'From completed', view: 'completed', filters: {} },
      { id: 'c', name: 'New', filters: { status: 'done' } },
      { id: 'd', name: 'Bare' },
    ]),
  );
  assert.deepEqual([a.filters.status, b.filters.status, c.filters.status, d.filters.status], ['open', 'done', 'done', 'open']);
});

test('views: Completed is no longer a view of its own', () => {
  assert.ok(!VIEWS.some((v) => (v.id as string) === 'completed'));
  assert.equal(VIEWS.find((v) => v.id === 'all')!.label, 'All tasks');
});
