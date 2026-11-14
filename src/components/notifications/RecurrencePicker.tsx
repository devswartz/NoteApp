// Recurrence picker: presets plus a custom editor (every N days/weeks/months/
// years, weekdays for weekly, day-of-month or "2nd Tuesday" for monthly,
// end date or count, repeat from due date or completion). Controlled:
//
//   <RecurrencePicker value={task.recurrence} dueDate={task.dueDate} onChange={(r) => updateTask(id, { recurrence: r })} />
//
// Meant to sit inside a Dropdown/Popover in the task detail panel.
import { useMemo, useState } from 'react';
import { Repeat, X } from 'lucide-react';
import { describeRecurrence, firstOccurrence, isISODate, previewOccurrences, WEEKDAY_SHORT, weekdayOf } from '../../../shared/recurrence.ts';
import type { Recurrence, RecurrenceOptions, Weekday } from '../../../shared/types.ts';
import { MiniCalendar } from '../MiniCalendar.tsx';
import './notifications.css';

type Unit = 'day' | 'week' | 'month' | 'year';
type MonthMode = 'day' | 'nth' | 'last';

const WEEK_ORDER: Weekday[] = [1, 2, 3, 4, 5, 6, 0];
const NTH_LABEL: Record<number, string> = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th', 5: '5th', [-1]: 'last' };

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function presets(anchor: string): { label: string; value: Recurrence }[] {
  const dow = weekdayOf(anchor);
  const dom = Number(anchor.slice(8, 10));
  const nth = Math.ceil(dom / 7);
  return [
    { label: 'Every day', value: { freq: 'day', interval: 1 } },
    { label: 'Every weekday (Mon–Fri)', value: { freq: 'weekday' } },
    { label: `Every week on ${WEEKDAY_SHORT[dow]}`, value: { freq: 'week', interval: 1, byWeekday: [dow] } },
    { label: 'Every 2 weeks', value: { freq: 'week', interval: 2, byWeekday: [dow] } },
    { label: `Every month on the ${dom}${suffix(dom)}`, value: { freq: 'month', interval: 1, byMonthDay: dom } },
    ...(nth <= 4
      ? [{ label: `Every month on the ${NTH_LABEL[nth]} ${WEEKDAY_SHORT[dow]}`, value: { freq: 'month', interval: 1, byNthWeekday: { n: nth, weekday: dow } } as Recurrence }]
      : []),
    { label: 'Every year', value: { freq: 'year', interval: 1, byMonthDay: dom } },
  ];
}

const suffix = (n: number) => (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th');
const same = (a: Recurrence | null, b: Recurrence | null) => JSON.stringify(a) === JSON.stringify(b);

export function RecurrencePicker({
  value,
  dueDate,
  onChange,
  onDone,
}: {
  value: Recurrence | null;
  /** The task's due date; anchors presets and the preview. */
  dueDate: string | null;
  onChange: (r: Recurrence | null) => void;
  /** Called after a choice is made (e.g. to close the popover). */
  onDone?: () => void;
}) {
  const anchor = dueDate && isISODate(dueDate) ? dueDate : todayLocal();
  const [custom, setCustom] = useState(() => !!value && !presets(anchor).some((p) => same(p.value, value)));
  const pick = (r: Recurrence | null) => {
    onChange(r);
    onDone?.();
  };

  if (custom) return <CustomRecurrence initial={value} anchor={anchor} onCancel={() => setCustom(false)} onSave={pick} />;
  return (
    <div className="menu rp" role="menu">
      {presets(anchor).map((p) => (
        <button key={p.label} type="button" role="menuitem" aria-current={same(value, p.value) || undefined} className="menu-item" onClick={() => pick(p.value)}>
          <span className="menu-icon">
            <Repeat size={15} />
          </span>
          <span className="menu-label">{p.label}</span>
          {same(value, p.value) && <span className="menu-check">✓</span>}
        </button>
      ))}
      <div className="menu-sep" />
      <button type="button" role="menuitem" className="menu-item" onClick={() => setCustom(true)}>
        <span className="menu-icon" />
        <span className="menu-label">Custom…</span>
        {value && !presets(anchor).some((p) => same(p.value, value)) && <span className="menu-hint">{describeRecurrence(value, dueDate)}</span>}
      </button>
      {value && (
        <button type="button" role="menuitem" className="menu-item" onClick={() => pick(null)}>
          <span className="menu-icon">
            <X size={15} />
          </span>
          <span className="menu-label">Does not repeat</span>
        </button>
      )}
    </div>
  );
}

function CustomRecurrence({
  initial,
  anchor,
  onSave,
  onCancel,
}: {
  initial: Recurrence | null;
  anchor: string;
  onSave: (r: Recurrence) => void;
  onCancel: () => void;
}) {
  const dow = weekdayOf(anchor);
  const dom = Number(anchor.slice(8, 10));
  const init: Recurrence = initial ?? { freq: 'week', interval: 1, byWeekday: [dow] };
  const [unit, setUnit] = useState<Unit | 'weekday'>(init.freq);
  const [n, setN] = useState(init.freq === 'weekday' ? 1 : init.interval);
  const [days, setDays] = useState<Weekday[]>(init.byWeekday?.length ? init.byWeekday : [dow]);
  const [monthMode, setMonthMode] = useState<MonthMode>(init.byNthWeekday ? 'nth' : init.byMonthDay === -1 ? 'last' : 'day');
  const [monthDay, setMonthDay] = useState(init.byMonthDay && init.byMonthDay > 0 ? init.byMonthDay : dom);
  const [nth, setNth] = useState<number>(init.byNthWeekday?.n ?? Math.min(4, Math.ceil(dom / 7)));
  const [nthDay, setNthDay] = useState<Weekday>(init.byNthWeekday?.weekday ?? dow);
  const [ends, setEnds] = useState<'never' | 'until' | 'count'>(init.until ? 'until' : init.count ? 'count' : 'never');
  const [until, setUntil] = useState(init.until ?? '');
  const [count, setCount] = useState(init.count ?? 10);
  const [basis, setBasis] = useState<'due' | 'completion'>(init.basis ?? 'due');

  const rule = useMemo<Recurrence>(() => {
    const opts: RecurrenceOptions = {};
    if (ends === 'until' && isISODate(until)) opts.until = until;
    if (ends === 'count' && count >= 1) opts.count = Math.floor(count);
    if (basis === 'completion') opts.basis = 'completion';
    if (unit === 'weekday') return { freq: 'weekday', ...opts };
    const interval = Math.min(365, Math.max(1, Math.floor(n) || 1));
    if (unit === 'week') return { freq: 'week', interval, byWeekday: days.length ? days : [dow], ...opts };
    if (unit === 'month') {
      if (monthMode === 'nth') return { freq: 'month', interval, byNthWeekday: { n: nth as 1, weekday: nthDay }, ...opts };
      return { freq: 'month', interval, byMonthDay: monthMode === 'last' ? -1 : monthDay, ...opts };
    }
    if (unit === 'year') return { freq: 'year', interval, byMonthDay: dom, ...opts };
    return { freq: 'day', interval, ...opts };
  }, [unit, n, days, monthMode, monthDay, nth, nthDay, ends, until, count, basis, dow, dom]);

  const preview = useMemo(() => previewOccurrences(rule, firstOccurrence(rule, anchor), 4), [rule, anchor]);
  const toggleDay = (d: Weekday) => setDays((xs) => (xs.includes(d) ? xs.filter((x) => x !== d) : [...xs, d]));

  return (
    <form
      className="rp-custom"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(rule);
      }}
    >
      <div className="rp-row">
        <span className="muted small">Every</span>
        {unit !== 'weekday' && (
          <input type="number" min={1} max={365} className="input input-sm rp-n" aria-label="Interval" value={n} onChange={(e) => setN(Number(e.target.value))} />
        )}
        <select className="input input-sm" aria-label="Frequency" value={unit} onChange={(e) => setUnit(e.target.value as Unit)}>
          <option value="day">{n === 1 ? 'day' : 'days'}</option>
          <option value="weekday">weekday (Mon–Fri)</option>
          <option value="week">{n === 1 ? 'week' : 'weeks'}</option>
          <option value="month">{n === 1 ? 'month' : 'months'}</option>
          <option value="year">{n === 1 ? 'year' : 'years'}</option>
        </select>
      </div>

      {unit === 'week' && (
        <div className="rp-days" role="group" aria-label="Days of the week">
          {WEEK_ORDER.map((d) => (
            <button key={d} type="button" className={`rp-day ${days.includes(d) ? 'on' : ''}`} aria-pressed={days.includes(d)} onClick={() => toggleDay(d)}>
              {WEEKDAY_SHORT[d].slice(0, 2)}
            </button>
          ))}
        </div>
      )}

      {unit === 'month' && (
        <div className="rp-col">
          <label className="rp-radio">
            <input type="radio" checked={monthMode === 'day'} onChange={() => setMonthMode('day')} /> On day
            <input type="number" min={1} max={31} className="input input-sm rp-n" aria-label="Day of month" value={monthDay} onChange={(e) => setMonthDay(Math.min(31, Math.max(1, Number(e.target.value) || 1)))} onFocus={() => setMonthMode('day')} />
          </label>
          <label className="rp-radio">
            <input type="radio" checked={monthMode === 'nth'} onChange={() => setMonthMode('nth')} /> On the
            <select className="input input-sm" aria-label="Which week" value={nth} onChange={(e) => (setNth(Number(e.target.value)), setMonthMode('nth'))}>
              {[1, 2, 3, 4, -1].map((k) => (
                <option key={k} value={k}>
                  {NTH_LABEL[k]}
                </option>
              ))}
            </select>
            <select className="input input-sm" aria-label="Weekday" value={nthDay} onChange={(e) => (setNthDay(Number(e.target.value) as Weekday), setMonthMode('nth'))}>
              {WEEK_ORDER.map((d) => (
                <option key={d} value={d}>
                  {WEEKDAY_SHORT[d]}
                </option>
              ))}
            </select>
          </label>
          <label className="rp-radio">
            <input type="radio" checked={monthMode === 'last'} onChange={() => setMonthMode('last')} /> On the last day
          </label>
        </div>
      )}

      <div className="rp-row">
        <span className="muted small">Ends</span>
        <select className="input input-sm" aria-label="Ends" value={ends} onChange={(e) => setEnds(e.target.value as typeof ends)}>
          <option value="never">Never</option>
          <option value="until">On date</option>
          <option value="count">After</option>
        </select>
        {ends === 'count' && (
          <>
            <input type="number" min={1} max={10000} className="input input-sm rp-n" aria-label="Occurrences" value={count} onChange={(e) => setCount(Number(e.target.value))} />
            <span className="muted small">times</span>
          </>
        )}
      </div>
      {ends === 'until' && <MiniCalendar value={isISODate(until) ? until : null} min={anchor} label="End date" onSelect={setUntil} />}

      <div className="rp-row">
        <span className="muted small">Next date counts from</span>
        <div className="segmented">
          <button type="button" className={basis === 'due' ? 'is-active' : ''} aria-pressed={basis === 'due'} onClick={() => setBasis('due')}>
            Due date
          </button>
          <button type="button" className={basis === 'completion' ? 'is-active' : ''} aria-pressed={basis === 'completion'} onClick={() => setBasis('completion')}>
            Completion
          </button>
        </div>
      </div>

      <div className="rp-summary">
        <strong>{describeRecurrence(rule, anchor)}</strong>
        <div className="muted small">Next: {preview.join(', ') || '—'}</div>
      </div>

      <div className="rp-row rp-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
          Back
        </button>
        <button type="submit" className="btn btn-primary btn-sm" disabled={ends === 'until' && !isISODate(until)}>
          Save
        </button>
      </div>
    </form>
  );
}
