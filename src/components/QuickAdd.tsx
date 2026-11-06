import { useMemo, useState } from 'react';
import { CalendarDays, Flag, Repeat, UserRound, FileText } from 'lucide-react';
import { createTask, ui, useStore } from '../store.ts';
import { parseQuickAdd } from '../../shared/quickadd.ts';
import { describeRecurrence } from '../../shared/dates.ts';
import { Avatar, Dropdown, Kbd, Modal } from './ui.tsx';
import { resolveMember } from './TaskRow.tsx';
import { AssigneeMenu, DueMenu, PRIORITY_COLORS, PriorityMenu } from './TaskControls.tsx';
import { describeDue, formatTime } from '../lib/format.ts';
import type { Priority } from '../../shared/types.ts';
import '../styles/tasks.css'; // .qa-keys (hidden on phones), quick-add touch targets

/** Global quick-add (Q). Parses natural language as you type. */
export function QuickAdd() {
  const defaults = useStore((s) => s.quickAdd);
  if (!defaults) return null;
  return <QuickAddInner key={JSON.stringify(defaults)} />;
}

function QuickAddInner() {
  const defaults = useStore((s) => s.quickAdd)!;
  const members = useStore((s) => s.members);
  const me = useStore((s) => s.user!.id);
  const page = useStore((s) => (defaults.pageId ? s.tree.pages.find((p) => p.id === defaults.pageId) : undefined));
  const [text, setText] = useState(defaults.text ?? '');
  const [desc, setDesc] = useState('');
  // Manual overrides from the pickers take precedence over parsed values.
  const [due, setDue] = useState<string | null | undefined>(defaults.dueDate ?? undefined);
  const [assignee, setAssignee] = useState<string | null | undefined>(defaults.assigneeId ?? undefined);
  const [priority, setPriority] = useState<Priority | undefined>();
  const parsed = useMemo(() => parseQuickAdd(text), [text]);
  const parsedAssignee = parsed.assignee ? resolveMember(parsed.assignee, members, me) : undefined;

  const final = {
    dueDate: due !== undefined ? due : parsed.dueDate,
    assigneeId: assignee !== undefined ? assignee : parsedAssignee ?? me,
    priority: priority ?? parsed.priority ?? 4,
  };
  const assigneeMember = members.find((m) => m.id === final.assigneeId);

  const submit = (keepOpen: boolean) => {
    const title = parsedAssignee || !parsed.assignee ? parsed.title : parsed.title + ' @' + parsed.assignee;
    if (!title.trim()) return;
    void createTask({
      title: title.trim(),
      description: desc,
      dueDate: final.dueDate,
      dueTime: parsed.dueTime,
      priority: final.priority as Priority,
      recurrence: parsed.recurrence,
      assigneeId: final.assigneeId,
      pageId: defaults.pageId ?? null,
    });
    if (keepOpen) {
      setText('');
      setDesc('');
    } else ui.closeQuickAdd();
  };

  // Highlight recognised tokens inside the input via an overlay.
  const highlighted = useMemo(() => {
    const out: React.ReactNode[] = [];
    let i = 0;
    for (const tk of parsed.tokens) {
      if (tk.kind === 'assignee' && !parsedAssignee) continue;
      out.push(text.slice(i, tk.start));
      out.push(
        <mark key={tk.start} className={`qa-token qa-${tk.kind}`}>
          {text.slice(tk.start, tk.end)}
        </mark>,
      );
      i = tk.end;
    }
    out.push(text.slice(i));
    return out;
  }, [parsed, text, parsedAssignee]);

  return (
    <Modal open onClose={ui.closeQuickAdd} className="quick-add" label="Quick add task">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(false);
        }}
      >
        <div className="qa-input-wrap">
          <div className="qa-highlight" aria-hidden>
            {highlighted}
          </div>
          <input
            autoFocus
            className="qa-input"
            placeholder={
              // The long example is clipped on phones; a shorter one shows the same syntax.
              window.matchMedia('(max-width: 760px)').matches ? 'e.g. Call Sam tomorrow 3pm p1' : 'e.g. Review proposal tomorrow 3pm p1 @alex every week'
            }
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit(true);
              }
            }}
          />
        </div>
        <textarea className="qa-desc" placeholder="Description" rows={1} value={desc} onChange={(e) => setDesc(e.target.value)} />
        <div className="qa-chips">
          <Dropdown buttonClass={`chip chip-btn ${final.dueDate ? 'chip-active' : ''}`} trigger={<><CalendarDays size={13} />{final.dueDate ? describeDue(final.dueDate) : 'Due date'}{parsed.dueTime && final.dueDate ? ` ${formatTime(parsed.dueTime)}` : ''}</>}>
            <DueMenu value={final.dueDate} onChange={setDue} />
          </Dropdown>
          <Dropdown buttonClass={`chip chip-btn ${final.priority < 4 ? 'chip-active' : ''}`} trigger={<><Flag size={13} color={PRIORITY_COLORS[final.priority]} />{final.priority < 4 ? `P${final.priority}` : 'Priority'}</>}>
            <PriorityMenu value={final.priority as Priority} onChange={setPriority} />
          </Dropdown>
          <Dropdown buttonClass="chip chip-btn" trigger={assigneeMember ? <><Avatar user={assigneeMember} size={14} />{assigneeMember.id === me ? 'Me' : assigneeMember.name}</> : <><UserRound size={13} />Unassigned</>}>
            <AssigneeMenu value={final.assigneeId} onChange={setAssignee} />
          </Dropdown>
          {parsed.recurrence && (
            <span className="chip chip-active">
              <Repeat size={13} />
              {describeRecurrence(parsed.recurrence)}
            </span>
          )}
          {page && (
            <span className="chip">
              <FileText size={13} /> {page.title || 'Untitled'}
            </span>
          )}
        </div>
        <div className="qa-foot">
          <span className="muted small qa-keys">
            <Kbd>↵</Kbd> add · <Kbd>{navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'} ↵</Kbd> add another
          </span>
          <div className="row gap-6">
            <button type="button" className="btn btn-secondary" onClick={ui.closeQuickAdd}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={!parsed.title.trim()}>
              Add task
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
