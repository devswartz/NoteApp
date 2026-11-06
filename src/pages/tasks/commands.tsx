// Dashboard keyboard workflow, registered in the central shortcut registry
// (src/hooks/useShortcuts.ts) so the `?` overlay and the palette list them and
// "G <letter>" sequences keep working. Row keys act on the focused task row.
import { canEditWorkspace, toggleTask, updateTask, useStore } from '../../store.ts';
import { useCommands, type Command } from '../../hooks/useShortcuts.ts';
import type { Priority } from '../../../shared/types.ts';
import { selection, useSelection } from './selection.ts';

const GROUP = 'Task lists';
export const RENAME_EVENT = 'noteapp:rename-task';

const rows = () => [...document.querySelectorAll<HTMLElement>('.tasks-page .task-row[data-task-id]')];
/** The task row that has keyboard focus, if any. */
const focusedRow = () => (document.activeElement as HTMLElement | null)?.closest?.<HTMLElement>('.tasks-page .task-row[data-task-id]') ?? null;
const focusedId = () => focusedRow()?.dataset.taskId ?? null;
const listFocused = () => !!(document.activeElement as HTMLElement | null)?.closest?.('.tasks-page');

function move(dir: 1 | -1) {
  const list = rows();
  if (!list.length) return;
  const i = list.indexOf(focusedRow()!);
  const next = list[i < 0 ? (dir > 0 ? 0 : list.length - 1) : Math.min(list.length - 1, Math.max(0, i + dir))];
  (next.querySelector<HTMLElement>('.task-title-btn') ?? next).focus();
  next.scrollIntoView({ block: 'nearest' });
}

export function useTaskListCommands() {
  useCommands(() => {
    // Row commands only match while a row has focus, so they're hidden from the `?` overlay
    // (it lists enabled commands); the help-only entries below describe them instead.
    const onRow = (c: Omit<Command, 'when' | 'group'> & { edit?: boolean }): Command => ({
      group: GROUP,
      palette: false,
      help: false,
      ...c,
      when: () => !!focusedId() && (!c.edit || canEditWorkspace()),
    });
    const help = (id: string, title: string, keys: string | string[]): Command => ({ id: `tasks.list.help.${id}`, title, keys, group: GROUP, palette: false });
    const priority = ([1, 2, 3, 4] as Priority[]).map((p) =>
      onRow({ id: `tasks.list.priority${p}`, title: `Set priority ${p}`, keys: String(p), edit: true, help: false, run: () => void updateTask(focusedId()!, { priority: p }) }),
    );
    return [
      { id: 'tasks.list.next', title: 'Next task', group: GROUP, keys: 'j', palette: false, when: () => rows().length > 0, run: () => move(1) },
      { id: 'tasks.list.prev', title: 'Previous task', group: GROUP, keys: 'k', palette: false, when: () => rows().length > 0, run: () => move(-1) },
      onRow({ id: 'tasks.list.down', title: 'Next task', keys: 'down', help: false, run: () => move(1) }),
      onRow({ id: 'tasks.list.up', title: 'Previous task', keys: 'up', help: false, run: () => move(-1) }),
      onRow({ id: 'tasks.list.complete', title: 'Complete task', keys: ['x', 'space'], edit: true, run: () => toggleTask(focusedId()!) }),
      onRow({ id: 'tasks.list.date', title: 'Set due date', keys: 'd', edit: true, run: () => focusedRow()?.querySelector<HTMLButtonElement>('.task-meta .chip-due')?.click() }),
      onRow({ id: 'tasks.list.assign', title: 'Assign', keys: 'a', edit: true, run: () => focusedRow()?.querySelector<HTMLButtonElement>('.task-side .avatar-btn')?.click() }),
      onRow({ id: 'tasks.list.rename', title: 'Rename task', keys: ['r', 'f2'], edit: true, run: () => void focusedRow()?.dispatchEvent(new Event(RENAME_EVENT)) }),
      onRow({ id: 'tasks.list.select', title: 'Select task (bulk actions)', keys: 's', edit: true, run: () => selection.toggle(focusedId()!) }),
      ...priority,
      help('complete', 'Complete focused task', ['x', 'space']),
      help('date', 'Set due date', 'd'),
      help('assign', 'Assign', 'a'),
      help('priority', 'Set priority', ['1', '2', '3', '4']),
      help('rename', 'Rename task', 'r'),
      help('select', 'Select task (bulk actions)', 's'),
      help('open', 'Open task details', 'enter'),
      help('selectAll', 'Select all tasks', 'mod+a'),
      help('clear', 'Clear selection', 'esc'),
      {
        id: 'tasks.list.selectAll',
        title: 'Select all tasks',
        group: GROUP,
        keys: 'mod+a',
        palette: false,
        // Only when the task list has focus (or a selection exists); otherwise ⌘A selects page text as usual.
        help: false,
        when: () => canEditWorkspace() && (listFocused() || useSelection.getState().ids.size > 0),
        run: selection.selectAll,
      },
      {
        id: 'tasks.list.clearSelection',
        title: 'Clear selection',
        group: GROUP,
        keys: 'esc',
        palette: false,
        help: false,
        when: () => useSelection.getState().ids.size > 0 && !useStore.getState().shortcutsOpen,
        run: selection.clear,
      },
    ];
  }, []);
}
