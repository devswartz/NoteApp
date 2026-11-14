// Date math for the built-in month calendar (MiniCalendar) in the due-date menu.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daysInMonth, firstWeekday, monthGrid, monthOf, shiftMonth, weekdayOrder } from '../src/lib/calendar.ts';
import { parseISODate } from '../shared/dates.ts';

test('the first weekday comes from the locale: Sunday in the US, Monday in the UK and Germany', () => {
  assert.equal(firstWeekday('en-US'), 0);
  assert.equal(firstWeekday('en-GB'), 1);
  assert.equal(firstWeekday('de-DE'), 1);
  assert.equal(firstWeekday('ar-EG'), 6, 'Saturday');
});

test('an unknown or malformed locale falls back to Sunday', () => {
  assert.equal(firstWeekday('not a locale!'), 0);
});

test('weekday columns start on the first weekday and wrap', () => {
  assert.deepEqual(weekdayOrder(0), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(weekdayOrder(1), [1, 2, 3, 4, 5, 6, 0]);
  assert.deepEqual(weekdayOrder(6), [6, 0, 1, 2, 3, 4, 5]);
});

test('a month grid is six full weeks starting on the first weekday, with the month inside', () => {
  // November 2026 starts on a Sunday.
  const sun = monthGrid(2026, 10, 0);
  assert.equal(sun.length, 42);
  assert.equal(sun[0], '2026-11-01');
  assert.equal(sun[41], '2026-12-12');
  const mon = monthGrid(2026, 10, 1);
  assert.equal(mon[0], '2026-10-26', 'Monday-first: starts on the Monday before');
  assert.equal(mon[6], '2026-11-01');
  for (const grid of [sun, mon]) {
    grid.forEach((d, i) => assert.equal(parseISODate(d).getDay(), (grid === sun ? i : i + 1) % 7, d));
    assert.ok(grid.includes('2026-11-30'));
  }
});

test('every day of every month of a year is in its grid, in order, with no gaps', () => {
  for (const first of [0, 1, 6]) {
    for (let m = 0; m < 12; m++) {
      const grid = monthGrid(2027, m, first);
      const own = grid.filter((d) => monthOf(d).month === m);
      assert.equal(own.length, daysInMonth(2027, m));
      assert.equal(own[0], `2027-${String(m + 1).padStart(2, '0')}-01`);
      for (let i = 1; i < grid.length; i++) {
        assert.equal(Math.round((parseISODate(grid[i]).getTime() - parseISODate(grid[i - 1]).getTime()) / 864e5), 1, `${grid[i - 1]} → ${grid[i]}`);
      }
    }
  }
});

test('leap years: February has 29 days in 2028 and 2000, 28 in 2027 and 1900', () => {
  assert.equal(daysInMonth(2028, 1), 29);
  assert.equal(daysInMonth(2000, 1), 29);
  assert.equal(daysInMonth(2027, 1), 28);
  assert.equal(daysInMonth(1900, 1), 28);
  const feb = monthGrid(2028, 1, 0);
  assert.ok(feb.includes('2028-02-29'));
  assert.equal(feb[feb.indexOf('2028-02-29') + 1], '2028-03-01');
});

test('month boundaries: year rollover in both directions', () => {
  assert.deepEqual(shiftMonth({ year: 2026, month: 11 }, 1), { year: 2027, month: 0 });
  assert.deepEqual(shiftMonth({ year: 2026, month: 0 }, -1), { year: 2025, month: 11 });
  assert.deepEqual(shiftMonth({ year: 2026, month: 10 }, -23), { year: 2024, month: 11 });
  assert.deepEqual(shiftMonth({ year: 2026, month: 10 }, 14), { year: 2028, month: 0 });
  const dec = monthGrid(2026, 11, 1);
  assert.equal(dec[0], '2026-11-30');
  assert.ok(dec.includes('2027-01-01'));
  assert.deepEqual(monthOf('2027-01-31'), { year: 2027, month: 0 });
});
