// The filters on every task view but All Tasks and Calendar: the same conditions, applied on top of
// what the view shows (src/pages/tasks/common.tsx useViewFilter). Phones get the chip bar to set them;
// desktop and tablet set them in the ribbon, so this just says what is on and offers to clear it.
import { useIsMobile } from '../../components/ui.tsx';
import { FilterChips, FilterSummary, activeKinds, clearedFilters } from './FilterChips.tsx';
import { taskView, useTaskView } from './taskViewState.ts';

export function ViewFilterBar() {
  const filters = useTaskView((s) => s.filters);
  const isMobile = useIsMobile();
  if (isMobile) return <FilterChips filters={filters} onChange={taskView.setFilters} />;
  if (!activeKinds(filters).length) return null;
  return (
    <div className="muted small result-count">
      {/* Search text and status belong to All Tasks, so they aren't part of what's shown here. */}
      <FilterSummary filters={{ ...filters, q: '', status: 'open' }} />
      <button type="button" className="btn-ghost btn-sm" onClick={() => taskView.setFilters(clearedFilters(filters))}>
        Clear filters
      </button>
    </div>
  );
}
