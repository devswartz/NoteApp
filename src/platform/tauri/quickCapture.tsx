// The quick-capture window (global hotkey ⌥⌘N / Ctrl+Alt+N, or File → Quick
// Capture). A small always-on-top window that adds a task (natural language, as
// in the app's quick add) or a note, then hides itself.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { emitTo } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { get, getAccessToken, post, refreshSession } from '../../api.ts';
import { parseQuickAdd } from '../../../shared/quickadd.ts';
import { describeDue } from '../../lib/format.ts';
import { resolveMember } from '../../components/TaskRow.tsx';
import type { Member, Tree, Workspace } from '../../../shared/types.ts';
import { platform } from '../index.ts';

type Mode = 'task' | 'note';

let me: string | null = null;

/** The signed-in user's id, restoring the session from the keychain if needed. */
async function session(): Promise<string | null> {
  if (getAccessToken() && me) return me;
  me = (await refreshSession().catch(() => null))?.user.id ?? null;
  return me;
}

async function workspaceId(): Promise<string | null> {
  const last = platform.kv.get('noteapp.lastWs');
  const list = await get<Workspace[]>('/workspaces');
  return list.find((w) => w.id === last)?.id ?? list[0]?.id ?? null;
}

const hide = () => void invoke('hide_quick_capture').catch(() => getCurrentWindow().hide());

function QuickCapture() {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<Mode>('task');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const parsed = useMemo(() => parseQuickAdd(text), [text]);

  useEffect(() => {
    const win = getCurrentWindow();
    const reset = () => {
      setError('');
      input.current?.focus();
      input.current?.select();
    };
    reset();
    // Hide when the user clicks elsewhere, like Spotlight.
    const un = win.onFocusChanged(({ payload }) => (payload ? reset() : hide()));
    return () => void un.then((f) => f());
  }, []);

  const submit = async () => {
    if (busy || !text.trim()) return;
    setBusy(true);
    setError('');
    try {
      const me = await session();
      if (!me) throw new Error('Sign in to the app first.');
      const ws = await workspaceId();
      if (!ws) throw new Error('Create a workspace in the app first.');
      if (mode === 'task') {
        let assigneeId: string | null = null;
        let title = parsed.title;
        if (parsed.assignee) {
          const members = await get<Member[]>(`/workspaces/${ws}/members`);
          const found = resolveMember(parsed.assignee, members, me);
          if (found) assigneeId = found;
          else title = `${title} @${parsed.assignee}`;
        }
        await post(`/workspaces/${ws}/tasks`, {
          id: crypto.randomUUID(),
          title: title.trim() || text.trim(),
          dueDate: parsed.dueDate,
          dueTime: parsed.dueTime,
          priority: parsed.priority ?? 4,
          recurrence: parsed.recurrence,
          assigneeId: assigneeId ?? me,
        });
      } else {
        const tree = await get<Tree>(`/workspaces/${ws}/tree`);
        const section = tree.sections[0];
        if (!section) throw new Error('Create a notebook in the app first.');
        const { id } = await post<{ id: string }>(`/sections/${section.id}/pages`, { title: text.trim() });
        await emitTo('main', 'open-path', `/w/${ws}/p/${id}`);
      }
      setText('');
      hide();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const chips = mode === 'task' ? [parsed.dueDate && describeDue(parsed.dueDate), parsed.dueTime, parsed.priority && `P${parsed.priority}`, parsed.recurrence && 'repeats', parsed.assignee && `@${parsed.assignee}`].filter(Boolean) : [];

  return (
    <div
      data-tauri-drag-region
      style={{ height: '100vh', display: 'grid', alignContent: 'center', gap: 8, padding: '14px 16px', background: 'var(--bg-elevated)', color: 'var(--text)', fontFamily: 'var(--font)', boxSizing: 'border-box', border: '1px solid var(--border)', borderRadius: 12 }}
    >
      <input
        ref={input}
        className="input"
        style={{ height: 44, fontSize: 'var(--text-lg)' }}
        value={text}
        disabled={busy}
        placeholder={mode === 'task' ? 'Add a task: “Send invoice tomorrow p1”' : 'New note title'}
        aria-label={mode === 'task' ? 'New task' : 'New note'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit();
          else if (e.key === 'Escape') hide();
          else if (e.key === 'Tab') {
            e.preventDefault();
            setMode((m) => (m === 'task' ? 'note' : 'task'));
          }
        }}
      />
      <div style={{ display: 'flex', gap: 8, fontSize: 'var(--text-xs)', color: error ? 'var(--danger)' : 'var(--text-3, var(--text-2))' }}>
        {error ? (
          <span role="alert">{error}</span>
        ) : (
          <>
            <span>
              <b>{mode === 'task' ? 'Task' : 'Note'}</b> · ↵ add · Tab {mode === 'task' ? 'note' : 'task'} · Esc close
            </span>
            {chips.map((c) => (
              <span key={String(c)} style={{ padding: '0 6px', borderRadius: 999, background: 'var(--accent-soft)', color: 'var(--accent)' }}>
                {c}
              </span>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

export async function mountQuickCapture() {
  document.documentElement.style.background = 'transparent';
  createRoot(document.getElementById('root')!).render(<QuickCapture />);
}
