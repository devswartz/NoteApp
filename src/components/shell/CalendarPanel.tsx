// The Calendar view's panel: a small month calendar to jump to a date, and
// on phones the assignee filter (desktop has Mine / Everyone in the ribbon). Both live in
// the URL (?d=YYYY-MM-DD&who=…) so CalendarView reads them too.
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useStore } from '../../store.ts';
import { calendarDate, calendarWho, monthGrid } from '../../pages/tasks/CalendarView.tsx';
import { parseISODate, toISODate, today } from '../../../shared/dates.ts';
import { Group } from './NotesPanel.tsx';
import { useIsMobile } from '../ui.tsx';

export function CalendarPanel({ wsId }: { wsId: string }) {
  const [params, setParams] = useSearchParams();
  const tasks = useStore((s) => s.tasks);
  const members = useStore((s) => s.members);
  const me = useStore((s) => s.user!.id);
  const selected = calendarDate(params);
  const who = calendarWho(params);
  const isMobile = useIsMobile();
  const [shown, setShown] = useState(selected.slice(0, 8) + '01');
  const [lastSelected, setLastSelected] = useState(selected);
  // Follow the big calendar when it moves to another month.
  if (lastSelected !== selected) {
    setLastSelected(selected);
    setShown(selected.slice(0, 8) + '01');
  }
  const t = today();
  const month = parseISODate(shown).getMonth();
  const busy = new Set(Object.values(tasks).filter((x) => x.status === 'open' && x.dueDate).map((x) => x.dueDate!));
  const step = (n: number) => {
    const d = parseISODate(shown);
    setShown(toISODate(new Date(d.getFullYear(), d.getMonth() + n, 1)));
  };
  const set = (key: string, value: string | null) =>
    setParams((p) => (value === null ? p.delete(key) : p.set(key, value), p), { replace: true });
  const weekdays = Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(undefined, { weekday: 'narrow' }).format(new Date(2024, 0, 1 + i)));
  const others = members.filter((m) => m.id !== me);

  return (
    <>
      <div className="panel-head">
        <h2 className="panel-title">Calendar</h2>
      </div>
      <div className="sb-scroll" data-ws={wsId}>
        <div className="mini-cal" aria-label="Choose a date">
          <div className="mini-cal-head">
            <span className="mini-cal-title">{new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(parseISODate(shown))}</span>
            <button className="btn-ghost icon-btn sm" aria-label="Previous month" onClick={() => step(-1)}>
              <ChevronLeft size={15} />
            </button>
            <button className="btn-ghost icon-btn sm" aria-label="Next month" onClick={() => step(1)}>
              <ChevronRight size={15} />
            </button>
          </div>
          <div className="mini-cal-grid" role="group" aria-label="Days">
            {weekdays.map((w, i) => (
              <span key={i} className="mini-cal-wd" aria-hidden="true">
                {w}
              </span>
            ))}
            {monthGrid(shown).map((d) => {
              const out = parseISODate(d).getMonth() !== month;
              return (
                <button
                  key={d}
                  type="button"
                  className={`mini-cal-day ${out ? 'is-out' : ''} ${d === t ? 'is-today' : ''} ${d === selected ? 'is-selected' : ''}`}
                  aria-label={new Intl.DateTimeFormat(undefined, { dateStyle: 'full' }).format(parseISODate(d))}
                  aria-pressed={d === selected}
                  onClick={() => set('d', d === t ? null : d)}
                >
                  {parseISODate(d).getDate()}
                  {busy.has(d) && <span className="mini-cal-dot" aria-hidden="true" />}
                </button>
              );
            })}
          </div>
        </div>
        {/* Desktop and tablet: Mine / Everyone is in the ribbon (SectionRibbons.tsx); phones have no ribbon. */}
        {isMobile && (
        <Group id={`calfilters:${wsId}`} title="Filters">
          <label className="panel-field">
            <span className="muted small">Assignee</span>
            <select className="input input-sm" value={who} onChange={(e) => set('who', e.target.value === 'mine' ? null : e.target.value)}>
              <option value="mine">Assigned to me</option>
              <option value="all">Everyone</option>
              <option value="none">Unassigned</option>
              {others.length > 0 && (
                <optgroup label="People">
                  {others.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </label>
        </Group>
        )}
      </div>
    </>
  );
}
