// Shared bits for the task dashboard views.
import { useMemo } from 'react';
import { useStore } from '../../store.ts';
import { visibleOpen } from '../../lib/taskViews.ts';

export function useOpen() {
  const tasks = useStore((s) => s.tasks);
  const lingering = useStore((s) => s.lingering);
  return useMemo(() => visibleOpen(tasks, lingering), [tasks, lingering]);
}

export function Loading() {
  return <div className="muted pad">Loading tasks…</div>;
}

export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: [T, string][] }) {
  return (
    <div className="segmented" role="tablist">
      {options.map(([v, l]) => (
        <button key={v} role="tab" aria-selected={value === v} className={value === v ? 'is-active' : ''} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}
