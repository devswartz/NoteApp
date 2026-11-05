import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextOccurrence } from '../shared/dates.ts';
import { parseQuickAdd } from '../shared/quickadd.ts';

const NOW = new Date(2026, 10, 5, 9, 0); // Thu 5 Nov 2026, local time

test('quick add parses date, priority, assignee', () => {
  const r = parseQuickAdd('Send invoice tomorrow p1 @sam', NOW);
  assert.equal(r.title, 'Send invoice');
  assert.equal(r.dueDate, '2026-11-06');
  assert.equal(r.priority, 1);
  assert.equal(r.assignee, 'sam');
});

test('quick add "today" sets due date to today', () => {
  const r = parseQuickAdd('Smoke inline task today', NOW);
  assert.equal(r.title, 'Smoke inline task');
  assert.equal(r.dueDate, '2026-11-05');
});

test('nextOccurrence rolls daily and weekday rules forward', () => {
  assert.equal(nextOccurrence({ freq: 'day', interval: 1 }, '2026-11-05', NOW), '2026-11-06');
  // Fri 6 Nov → Mon 9 Nov
  assert.equal(nextOccurrence({ freq: 'weekday' }, '2026-11-06', NOW), '2026-11-09');
});
