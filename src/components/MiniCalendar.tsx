// A small month calendar for picking one date inside a menu or form (replaces <input type="date">,
// whose native picker changes the value as you step through months: in WebView2/Chromium that
// committed a due date and closed the menu after one month step).
//
// The month buttons only navigate; a date is picked only by clicking a day or pressing Enter on it.
// Keyboard: arrows move the focused day, PageUp/PageDown change month (with Shift, year),
// Home/End go to the start/end of the week, Enter or Space picks.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { addDays, addMonths, parseISODate as date, today as todayISO } from '../../shared/dates.ts';
import { firstWeekday, monthGrid, monthOf, shiftMonth, weekdayOrder, GRID_WEEKS } from '../lib/calendar.ts';

export function MiniCalendar({
  value,
  onSelect,
  min,
  label = 'Choose date',
}: {
  /** The selected date (YYYY-MM-DD), if any. */
  value: string | null;
  onSelect: (date: string) => void;
  /** Days before this date can't be picked. */
  min?: string;
  /** Accessible name of the calendar. */
  label?: string;
}) {
  const t = todayISO();
  const [focused, setFocused] = useState(() => value ?? (min && min > t ? min : t));
  const [view, setView] = useState(() => monthOf(focused));
  const gridRef = useRef<HTMLDivElement>(null);
  const moved = useRef(false);
  const titleId = useId();

  const first = useMemo(() => firstWeekday(), []);
  const days = useMemo(() => monthGrid(view.year, view.month, first), [view, first]);
  const fmt = useMemo(
    () => ({
      title: new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }),
      full: new Intl.DateTimeFormat(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
      dow: new Intl.DateTimeFormat(undefined, { weekday: 'short' }),
      dowLong: new Intl.DateTimeFormat(undefined, { weekday: 'long' }),
    }),
    [],
  );
  // 2023-01-01 was a Sunday: weekday d is January d+1.
  const weekdayName = (d: number, long = false) => (long ? fmt.dowLong : fmt.dow).format(new Date(2023, 0, 1 + d));

  // The grid's one tab stop: the focused day, or the 1st when it isn't on show.
  const tabStop = days.includes(focused) ? focused : days.find((d) => monthOf(d).month === view.month)!;

  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-date="${focused}"]`)?.focus();
  }, [focused, view]);

  const disabled = (iso: string) => !!min && iso < min;
  const pick = (iso: string) => {
    if (!disabled(iso)) onSelect(iso);
  };
  const moveTo = (iso: string) => {
    moved.current = true;
    setFocused(iso);
    setView(monthOf(iso));
  };
  const step = (n: number) => {
    setView((v) => shiftMonth(v, n));
    setFocused((f) => addMonths(f, n));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const from = tabStop;
    const col = weekdayOrder(first).indexOf(date(from).getDay());
    let to: string | null = null;
    switch (e.key) {
      case 'ArrowLeft': to = addDays(from, -1); break;
      case 'ArrowRight': to = addDays(from, 1); break;
      case 'ArrowUp': to = addDays(from, -7); break;
      case 'ArrowDown': to = addDays(from, 7); break;
      case 'Home': to = addDays(from, -col); break;
      case 'End': to = addDays(from, 6 - col); break;
      case 'PageUp': to = addMonths(from, e.shiftKey ? -12 : -1); break;
      case 'PageDown': to = addMonths(from, e.shiftKey ? 12 : 1); break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        pick(from);
        return;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    moveTo(to);
  };

  const weeks = Array.from({ length: GRID_WEEKS }, (_, w) => days.slice(w * 7, w * 7 + 7));
  return (
    // Clicks stay inside: a menu is rendered in a portal but React still bubbles its clicks to the
    // trigger's ancestors (a task row would open the task).
    <div className="dcal" onClick={(e) => e.stopPropagation()}>
      <div className="dcal-head">
        <button type="button" className="icon-btn btn-ghost dcal-nav" aria-label="Previous month" title="Previous month" onClick={() => step(-1)}>
          <ChevronLeft size={16} />
        </button>
        <div id={titleId} className="dcal-title" aria-live="polite">
          {fmt.title.format(new Date(view.year, view.month, 1))}
        </div>
        <button type="button" className="icon-btn btn-ghost dcal-nav" aria-label="Next month" title="Next month" onClick={() => step(1)}>
          <ChevronRight size={16} />
        </button>
      </div>
      <div ref={gridRef} role="grid" className="dcal-grid" aria-label={label} aria-describedby={titleId} onKeyDown={onKeyDown}>
        <div role="row" className="dcal-row">
          {weekdayOrder(first).map((d) => (
            <div key={d} role="columnheader" className="dcal-dow" aria-label={weekdayName(d, true)}>
              {weekdayName(d).slice(0, 2)}
            </div>
          ))}
        </div>
        {weeks.map((week) => (
          <div key={week[0]} role="row" className="dcal-row">
            {week.map((iso) => {
              const outside = monthOf(iso).month !== view.month;
              const selected = iso === value;
              const isToday = iso === t;
              const off = disabled(iso);
              const cls = ['dcal-day', outside && 'is-outside', iso < t && 'is-past', isToday && 'is-today', selected && 'is-selected'].filter(Boolean).join(' ');
              return (
                <div key={iso} role="gridcell" aria-selected={selected} className="dcal-cell">
                  <button
                    type="button"
                    className={cls}
                    data-date={iso}
                    tabIndex={iso === tabStop ? 0 : -1}
                    aria-label={`${fmt.full.format(date(iso))}${isToday ? ', today' : ''}`}
                    aria-current={isToday ? 'date' : undefined}
                    aria-disabled={off || undefined}
                    onFocus={() => setFocused(iso)}
                    onClick={() => pick(iso)}
                  >
                    {Number(iso.slice(8, 10))}
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
