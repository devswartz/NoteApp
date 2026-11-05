import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeRecurrence,
  firstOccurrence,
  nextOccurrence,
  parseRecurrence,
  previewOccurrences,
  recurrenceError,
  stepAfter,
  todayIn,
  zonedTimeToUtc,
} from '../shared/recurrence.ts';
import type { Recurrence } from '../shared/types.ts';

const next = (rule: Recurrence, dueDate: string | null, today: string, completedCount?: number) =>
  nextOccurrence(rule, { dueDate, today, completedCount });
const series = (rule: Recurrence, start: string, n = 6) => previewOccurrences(rule, start, n);

test('daily and every N days', () => {
  assert.equal(next({ freq: 'day', interval: 1 }, '2026-11-05', '2026-11-05'), '2026-11-06');
  assert.equal(next({ freq: 'day', interval: 3 }, '2026-12-30', '2026-12-30'), '2027-01-02');
});

test('weekdays skip the weekend', () => {
  assert.equal(next({ freq: 'weekday' }, '2026-11-06', '2026-11-06'), '2026-11-09'); // Fri → Mon
  assert.deepEqual(series({ freq: 'weekday' }, '2026-11-05', 4), ['2026-11-05', '2026-11-06', '2026-11-09', '2026-11-10']);
});

test('weekly on chosen days, every N weeks', () => {
  const r: Recurrence = { freq: 'week', interval: 1, byWeekday: [1, 4] }; // Mon, Thu
  assert.deepEqual(series(r, '2026-11-02', 5), ['2026-11-02', '2026-11-05', '2026-11-09', '2026-11-12', '2026-11-16']);
  const r2: Recurrence = { freq: 'week', interval: 2, byWeekday: [4, 1] };
  assert.deepEqual(series(r2, '2026-11-02', 5), ['2026-11-02', '2026-11-05', '2026-11-16', '2026-11-19', '2026-11-30']);
  // Sunday counts as the end of the week (weeks start Monday).
  const r3: Recurrence = { freq: 'week', interval: 2, byWeekday: [0, 1] };
  assert.deepEqual(series(r3, '2026-11-02', 4), ['2026-11-02', '2026-11-08', '2026-11-16', '2026-11-22']);
  // Plain weekly keeps the weekday.
  assert.equal(next({ freq: 'week', interval: 1 }, '2026-11-05', '2026-11-05'), '2026-11-12');
});

test('monthly by day of month clamps at month end without drifting', () => {
  const r: Recurrence = { freq: 'month', interval: 1, byMonthDay: 31 };
  assert.deepEqual(series(r, '2027-01-31', 5), ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31']);
  const last: Recurrence = { freq: 'month', interval: 1, byMonthDay: -1 };
  assert.deepEqual(series(last, '2028-01-31', 3), ['2028-01-31', '2028-02-29', '2028-03-31']);
  // Plain monthly from the 15th.
  assert.equal(next({ freq: 'month', interval: 1 }, '2026-11-15', '2026-11-15'), '2026-12-15');
  assert.equal(next({ freq: 'month', interval: 2 }, '2026-11-30', '2026-11-30'), '2027-01-30');
});

test('monthly by nth weekday', () => {
  const r: Recurrence = { freq: 'month', interval: 1, byNthWeekday: { n: 2, weekday: 2 } }; // 2nd Tuesday
  assert.deepEqual(series(r, '2026-11-10', 3), ['2026-11-10', '2026-12-08', '2027-01-12']);
  const lastFri: Recurrence = { freq: 'month', interval: 1, byNthWeekday: { n: -1, weekday: 5 } };
  assert.deepEqual(series(lastFri, '2026-11-27', 3), ['2026-11-27', '2026-12-25', '2027-01-29']);
  // 5th Monday skips months that don't have one.
  const fifth: Recurrence = { freq: 'month', interval: 1, byNthWeekday: { n: 5, weekday: 1 } };
  assert.deepEqual(series(fifth, '2026-11-30', 3), ['2026-11-30', '2027-03-29', '2027-05-31']);
});

test('yearly and Feb 29', () => {
  assert.equal(next({ freq: 'year', interval: 1 }, '2026-11-05', '2026-11-05'), '2027-11-05');
  const leap: Recurrence = { freq: 'year', interval: 1, byMonthDay: 29 };
  assert.deepEqual(series(leap, '2028-02-29', 5), ['2028-02-29', '2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29']);
});

test('due basis skips past occurrences; completion basis counts from today', () => {
  // Overdue daily task completed a week late lands tomorrow, not in the past.
  assert.equal(next({ freq: 'day', interval: 1 }, '2026-10-29', '2026-11-05'), '2026-11-06');
  // Every Monday, completed on Thursday after being overdue: next Monday.
  assert.equal(next({ freq: 'week', interval: 1, byWeekday: [1] }, '2026-10-26', '2026-11-05'), '2026-11-09');
  // Completed early: due basis keeps the schedule.
  assert.equal(next({ freq: 'week', interval: 1 }, '2026-11-12', '2026-11-05'), '2026-11-19');
  // From completion: 3 days after today, whatever the due date was.
  assert.equal(next({ freq: 'day', interval: 3, basis: 'completion' }, '2026-10-01', '2026-11-05'), '2026-11-08');
  assert.equal(next({ freq: 'day', interval: 1 }, null, '2026-11-05'), '2026-11-06');
});

test('until and count end the series', () => {
  assert.equal(next({ freq: 'day', interval: 1, until: '2026-11-06' }, '2026-11-05', '2026-11-05'), '2026-11-06');
  assert.equal(next({ freq: 'day', interval: 1, until: '2026-11-06' }, '2026-11-06', '2026-11-06'), null);
  assert.equal(next({ freq: 'week', interval: 1, count: 3 }, '2026-11-05', '2026-11-05', 2), '2026-11-12');
  assert.equal(next({ freq: 'week', interval: 1, count: 3 }, '2026-11-12', '2026-11-12', 3), null);
  assert.deepEqual(series({ freq: 'day', interval: 1, count: 2 }, '2026-11-05'), ['2026-11-05', '2026-11-06']);
});

test('firstOccurrence aligns patterned rules', () => {
  assert.equal(firstOccurrence({ freq: 'week', interval: 2, byWeekday: [1] }, '2026-11-05'), '2026-11-09');
  assert.equal(firstOccurrence({ freq: 'week', interval: 1, byWeekday: [4] }, '2026-11-05'), '2026-11-05');
  assert.equal(firstOccurrence({ freq: 'month', interval: 1, byMonthDay: 15 }, '2026-11-20'), '2026-12-15');
  assert.equal(firstOccurrence({ freq: 'weekday' }, '2026-11-07'), '2026-11-09');
  assert.equal(firstOccurrence({ freq: 'day', interval: 2 }, '2026-11-07'), '2026-11-07');
});

test('old rules still work through stepAfter', () => {
  assert.equal(stepAfter({ freq: 'month', interval: 1 }, '2026-01-31'), '2026-02-28');
});

test('time zones: today and local time → instant across DST', () => {
  const t = Date.parse('2026-11-05T23:30:00Z');
  assert.equal(todayIn('UTC', t), '2026-11-05');
  assert.equal(todayIn('Asia/Tokyo', t), '2026-11-06');
  assert.equal(todayIn('America/Los_Angeles', t), '2026-11-05');
  // Summer and winter time in London.
  assert.equal(zonedTimeToUtc('2026-07-01', '09:00', 'Europe/London').toISOString(), '2026-07-01T08:00:00.000Z');
  assert.equal(zonedTimeToUtc('2026-12-01', '09:00', 'Europe/London').toISOString(), '2026-12-01T09:00:00.000Z');
  // Spring forward (29 Mar 2026, 01:00 → 02:00): 01:30 doesn't exist → 02:30 BST.
  assert.equal(zonedTimeToUtc('2026-03-29', '01:30', 'Europe/London').toISOString(), '2026-03-29T01:30:00.000Z');
  // Fall back (25 Oct 2026): 01:30 happens twice → the first (BST).
  assert.equal(zonedTimeToUtc('2026-10-25', '01:30', 'Europe/London').toISOString(), '2026-10-25T00:30:00.000Z');
  // US DST (8 Mar 2026): 02:30 skipped → 03:30 PDT.
  assert.equal(zonedTimeToUtc('2026-03-08', '02:30', 'America/Los_Angeles').toISOString(), '2026-03-08T10:30:00.000Z');
  assert.equal(zonedTimeToUtc('2026-03-09', '09:00', 'America/Los_Angeles').toISOString(), '2026-03-09T16:00:00.000Z');
  // Half-hour zone, date line.
  assert.equal(zonedTimeToUtc('2026-11-05', '09:00', 'Asia/Kolkata').toISOString(), '2026-11-05T03:30:00.000Z');
  assert.equal(zonedTimeToUtc('2026-11-05', '00:15', 'Pacific/Auckland').toISOString(), '2026-11-04T11:15:00.000Z');
});

test('daily 9am reminder keeps local time across a DST change', () => {
  const rule: Recurrence = { freq: 'day', interval: 1 };
  const days = series(rule, '2026-03-27', 4);
  const hours = days.map((d) => zonedTimeToUtc(d, '09:00', 'Europe/London').getUTCHours());
  assert.deepEqual(hours, [9, 9, 8, 8]);
});

test('validation', () => {
  assert.equal(recurrenceError({ freq: 'day', interval: 1 }), null);
  assert.equal(recurrenceError({ freq: 'weekday' }), null);
  assert.equal(recurrenceError({ freq: 'week', interval: 1, byWeekday: [1, 4], until: '2027-01-01', count: 5, basis: 'completion' }), null);
  assert.ok(recurrenceError({ freq: 'week', interval: 0 }));
  assert.ok(recurrenceError({ freq: 'week', interval: 1, byWeekday: [7] }));
  assert.ok(recurrenceError({ freq: 'month', interval: 1, byMonthDay: 32 }));
  assert.ok(recurrenceError({ freq: 'month', interval: 1, byNthWeekday: { n: 6, weekday: 1 } }));
  assert.ok(recurrenceError({ freq: 'day', interval: 1, until: '2026-02-30' }));
  assert.ok(recurrenceError({ freq: 'hour', interval: 1 }));
});

test('natural-language parsing', () => {
  const p = (s: string) => parseRecurrence(s)?.rule;
  assert.deepEqual(p('Standup every weekday'), { freq: 'weekday' });
  assert.deepEqual(p('Gym every 2 weeks on mon,thu'), { freq: 'week', interval: 2, byWeekday: [1, 4] });
  assert.deepEqual(p('every week on Monday and Wednesday'), { freq: 'week', interval: 1, byWeekday: [1, 3] });
  assert.deepEqual(p('Rent every month on the 15th'), { freq: 'month', interval: 1, byMonthDay: 15 });
  assert.deepEqual(p('every month on the last day'), { freq: 'month', interval: 1, byMonthDay: -1 });
  assert.deepEqual(p('Review every 2nd tuesday'), { freq: 'month', interval: 1, byNthWeekday: { n: 2, weekday: 2 } });
  assert.deepEqual(p('every last friday of the month'), { freq: 'month', interval: 1, byNthWeekday: { n: -1, weekday: 5 } });
  assert.deepEqual(p('every 3 months on the first monday'), { freq: 'month', interval: 3, byNthWeekday: { n: 1, weekday: 1 } });
  assert.deepEqual(p('every monday'), { freq: 'week', interval: 1, byWeekday: [1] });
  assert.deepEqual(p('every mon and thu'), { freq: 'week', interval: 1, byWeekday: [1, 4] });
  assert.deepEqual(p('every other week'), { freq: 'week', interval: 2 });
  assert.deepEqual(p('every 3 days'), { freq: 'day', interval: 3 });
  assert.deepEqual(p('every day'), { freq: 'day', interval: 1 });
  assert.deepEqual(p('every year'), { freq: 'year', interval: 1 });
  assert.deepEqual(p('Pay invoice monthly'), { freq: 'month', interval: 1 });
  assert.deepEqual(p('every 15th'), { freq: 'month', interval: 1, byMonthDay: 15 });
  assert.deepEqual(p('water plants every 3 days after completion'), { freq: 'day', interval: 3, basis: 'completion' });
  assert.deepEqual(p('every week until 2026-12-31'), { freq: 'week', interval: 1, until: '2026-12-31' });
  assert.deepEqual(p('every day for 10 times'), { freq: 'day', interval: 1, count: 10 });
  assert.equal(p('everyone loves monday'), undefined);
  const m = parseRecurrence('Pay rent every month on the 1st p1')!;
  assert.equal('Pay rent every month on the 1st p1'.slice(m.start, m.end), 'every month on the 1st');
});

test('describeRecurrence', () => {
  assert.equal(describeRecurrence({ freq: 'week', interval: 2, byWeekday: [4, 1] }), 'Every 2 weeks on Mon, Thu');
  assert.equal(describeRecurrence({ freq: 'month', interval: 1, byNthWeekday: { n: 2, weekday: 2 } }), 'Every month on the 2nd Tuesday');
  assert.equal(describeRecurrence({ freq: 'month', interval: 1, byMonthDay: 22 }), 'Every month on the 22nd');
  assert.equal(describeRecurrence({ freq: 'weekday' }), 'Every weekday');
  assert.equal(describeRecurrence({ freq: 'day', interval: 3, basis: 'completion', count: 4 }), 'Every 3 days after completion, 4 times');
  assert.equal(describeRecurrence({ freq: 'year', interval: 1 }, '2026-02-14'), 'Every year on Feb 14');
});
