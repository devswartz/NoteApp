// A reference for the native core's quick add and repeat-rule text (crates/nv-core/src/quickadd.rs,
// recurrence.rs): today's web code (`parseQuickAdd`, `firstOccurrence`, `describeRecurrence`,
// `shared/quickadd.ts` and `shared/recurrence.ts`) is run over a list of lines and rules and the
// results are committed in tests/corpus/quickadd.json. `crates/nv-core/tests/quickadd.rs`
// must reproduce every one.
//   node --import tsx scripts/corpus/quickadd.ts
// The web reads "today" from a local `Date`; it is built here from year, month and day, so the
// result doesn't depend on the machine's time zone.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseQuickAdd } from '../../shared/quickadd.ts';
import { describeRecurrence, firstOccurrence } from '../../shared/recurrence.ts';
import type { Recurrence } from '../../shared/types.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tests/corpus');

// Thu 5 Nov 2026; Tue 29 Feb 2028 (leap day); Thu 31 Dec 2026 (year end); Sun 31 Jan 2027 (month end).
const TODAYS = ['2026-11-05', '2028-02-29', '2026-12-31', '2027-01-31'];

const INPUTS = [
  '',
  'Just a title',
  'Send invoice tomorrow p1 @sam',
  'Smoke inline task today',
  'Call Sam tomorrow 3pm p1 @devon',
  'Ship v2 by 2026-12-01',
  'Lunch with Ana at noon',
  'Midnight snack at midnight',
  'Wake up tmr at 7:30am',
  'Dinner tonight at 19:45',
  'Call at 25:00 nobody',
  'Meet at 13pm',
  'Meet at 0am',
  'Meet 12am and 12pm',
  'Standup 9:05 am',
  'Review next week',
  'Review next month',
  'Review in 3 days',
  'Review in 2 weeks',
  'Review in 1 month',
  'Review in 12 months',
  'Pay bill on friday',
  'Pay bill next friday',
  'Pay bill friday',
  'Pay bill by Friday',
  'Pay bill due tomorrow',
  'Do it on mon',
  'Do it thurs',
  'Do it sat',
  'Do it sun',
  'Do it wednesday',
  'Do it tues',
  'Sat down with the team',
  'Book hall Nov 30',
  'Book hall on Dec 25th',
  'Book hall January 5',
  'Book hall Sept 9',
  'Book hall 3 March',
  'Book hall on the 4th of March',
  'Book hall 21st Oct',
  'Book hall Feb 29',
  'Book hall Feb 30',
  'Book hall Apr 31',
  'Book hall may 1',
  'Book hall 1 may',
  'Birthday Jan 1',
  'Birthday Nov 5',
  'Birthday Nov 4',
  'Date 2026-02-30 broken',
  'Date 2026-13-01 broken',
  'Date 2027-02-29 broken',
  'Date 2028-02-29 leap',
  'Date 0050-01-01 odd',
  'Plan p2',
  'Plan !p3',
  'Plan p5',
  'Plan p4 p1',
  'Plan xp1',
  'Fix bug #urgent #Backend #urgent',
  'Fix bug #123 stays',
  'Fix bug #a-b_c',
  'Fix bug # alone',
  'Ask @me about it',
  'Ask @Sam.Lee about it',
  'Ask @sam @pat about it',
  'email me@home.com about it',
  'Book the hall #waiting #budget +elders',
  'Book the hall +elders +youth',
  'Book the hall + nothing',
  'Café ☕ tomorrow #café',
  'Émile à la fête demain @émile',
  '😀 smile tomorrow 😀 p2',
  '日本語 tomorrow',
  'Gym every 2 weeks on mon,thu',
  'Pay rent every month on the 15th p1',
  'Team review every 2nd tuesday',
  'Standup every weekday',
  'Standup weekdays',
  'Chores every saturday',
  'Invoice every month Nov 30',
  'Water plants every 3 days after completion',
  'Report every friday 4pm @sam',
  'Daily check daily',
  'Weekly review weekly',
  'Pay biweekly',
  'Pay fortnightly',
  'Rent monthly',
  'Taxes quarterly',
  'Renew yearly',
  'Renew annually on Dec 25',
  'Every day',
  'every other week',
  'every other day',
  'every two weeks',
  'every 3 months',
  'every year',
  'every 15th',
  'every 31st',
  'every 32nd',
  'every last friday',
  'every first monday of the month',
  'the 3rd thursday',
  'every month on the last day',
  'every 2 months on the 10th',
  'every month on the 2nd tuesday',
  'every mon and thu',
  'every mon, wed & fri',
  'every week on tuesday',
  'every month until 2027-06-30',
  'every month until 2027-02-30',
  'every day for 10 times',
  'every day x5',
  'every day x 5',
  'every week from completion',
  'every week after done until 2027-01-01 for 3 times',
  'Take pills every day at 8am',
  'Take pills every day at 8am until 2027-01-01',
  'Pick up kids every weekday at 3:30 pm',
  'Call mum on sunday every 2 weeks',
  'Sunday every month',
  'every 1000 days',
  'every 0 days',
  'Gym mon wed fri',
  '  spaces   everywhere   tomorrow   ',
  'tomorrow tomorrow',
  'today tomorrow',
  'monday tuesday',
  'at 5pm at 6pm',
  'Meeting at 5 with Bo',
  'Meeting in 5 days at 10',
  'Call tod',
  'Plan p1 #a +b @c tomorrow at 9am every week',
  'Hello\nworld tomorrow',
  'Tab\tseparated p2',
];

const RULES: Recurrence[] = [
  { freq: 'day', interval: 1 },
  { freq: 'day', interval: 3, basis: 'completion', count: 4 },
  { freq: 'weekday' },
  { freq: 'weekday', until: '2026-12-31' },
  { freq: 'week', interval: 1 },
  { freq: 'week', interval: 2, byWeekday: [4, 1] },
  { freq: 'week', interval: 1, byWeekday: [0, 6] },
  { freq: 'week', interval: 3, byWeekday: [0, 1], until: '2027-03-01' },
  { freq: 'month', interval: 1 },
  { freq: 'month', interval: 2, byMonthDay: 31 },
  { freq: 'month', interval: 1, byMonthDay: -1 },
  { freq: 'month', interval: 1, byMonthDay: 22 },
  { freq: 'month', interval: 1, byMonthDay: 1 },
  { freq: 'month', interval: 1, byMonthDay: 3 },
  { freq: 'month', interval: 1, byMonthDay: 11 },
  { freq: 'month', interval: 1, byNthWeekday: { n: 2, weekday: 2 } },
  { freq: 'month', interval: 1, byNthWeekday: { n: -1, weekday: 5 } },
  { freq: 'month', interval: 3, byNthWeekday: { n: 5, weekday: 1 } },
  { freq: 'month', interval: 1, byNthWeekday: { n: 1, weekday: 0 } },
  { freq: 'year', interval: 1 },
  { freq: 'year', interval: 2, byMonthDay: 29 },
];
const DUES = [null, '2026-02-14', '2026-11-05', '2028-02-29', '2026-12-31'];
const FROMS = ['2026-11-05', '2026-11-06', '2026-11-08', '2028-02-29', '2026-12-31', '2027-01-31'];

const cases = TODAYS.flatMap((today) => {
  const [y, m, d] = today.split('-').map(Number);
  const now = new Date(y, m - 1, d, 9, 0);
  return INPUTS.map((input) => ({ today, input, expected: JSON.parse(JSON.stringify(parseQuickAdd(input, now))) }));
});

const rules = RULES.map((rule) => ({
  rule,
  describe: DUES.map((due) => ({ dueDate: due, text: describeRecurrence(rule, due) })),
  firstOccurrence: FROMS.map((from) => ({ from, date: firstOccurrence(rule, from) })),
}));

const out = {
  about:
    'parseQuickAdd(input, today) from shared/quickadd.ts, and describeRecurrence / firstOccurrence from shared/recurrence.ts, run by scripts/corpus/quickadd.ts. Token offsets are UTF-16 code units.',
  cases,
  rules,
};
fs.writeFileSync(path.join(ROOT, 'quickadd.json'), JSON.stringify(out, null, 1) + '\n');
console.log(`quickadd.json: ${cases.length} lines, ${rules.length} rules`);
