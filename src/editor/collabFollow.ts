// "Follow" a collaborator on the same page: click their avatar and the editor
// keeps their cursor in view as they move, until you scroll, click or type.
// Owner: Collaboration & Access.
//
//   CollaborationCaret.configure({ provider, user, render: renderCaret })   // tags carets with data-user-id
//   const following = useFollow(provider.awareness, editorElement)          // in the page view
//   <PresenceStack users={presence} following={following.id} onFollow={following.start} />
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Awareness } from 'y-protocols/awareness';

/** Same caret as the default, plus data-user-id so it can be found reliably. */
export function renderCaret(user: { id?: string; name?: string; color?: string }): HTMLElement {
  const color = /^#[0-9a-f]{3,8}$/i.test(user.color ?? '') ? user.color! : '#6366f1';
  const caret = document.createElement('span');
  caret.classList.add('collaboration-carets__caret');
  caret.style.borderColor = color;
  if (user.id) caret.dataset.userId = user.id;
  const label = document.createElement('div');
  label.classList.add('collaboration-carets__label');
  label.style.backgroundColor = color;
  label.textContent = user.name ?? '';
  caret.append(label);
  return caret;
}

/** The rendered caret of `user` inside `root` (by data-user-id, else by label text). */
export function findCaret(root: ParentNode, user: { id: string; name: string }): HTMLElement | null {
  const byId = root.querySelector<HTMLElement>(`.collaboration-carets__caret[data-user-id="${CSS.escape(user.id)}"]`);
  if (byId) return byId;
  for (const el of root.querySelectorAll<HTMLElement>('.collaboration-carets__caret'))
    if (el.querySelector('.collaboration-carets__label')?.textContent === user.name) return el;
  return null;
}

/** Scroll `el` into view only if it isn't comfortably visible already. */
function reveal(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  const margin = 80;
  if (r.top < margin || r.bottom > window.innerHeight - margin) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

export interface Following {
  /** User id being followed, or null. */
  id: string | null;
  name: string | null;
  start: (user: { id: string; name: string }) => void;
  stop: () => void;
}

export function useFollow(awareness: Awareness | null | undefined, root: HTMLElement | null): Following {
  const [target, setTarget] = useState<{ id: string; name: string } | null>(null);
  const programmatic = useRef(false);

  const stop = useCallback(() => setTarget(null), []);
  const start = useCallback((u: { id: string; name: string }) => setTarget((t) => (t?.id === u.id ? null : u)), []);

  useEffect(() => {
    if (!target || !awareness || !root) return;
    const jump = () => {
      // Stop when they leave the page.
      const here = [...awareness.getStates().values()].some((s) => (s as { user?: { id?: string } }).user?.id === target.id);
      if (!here) return setTarget(null);
      // Carets render after the editor view updates; wait a frame.
      requestAnimationFrame(() => {
        const el = findCaret(root, target);
        if (!el) return;
        programmatic.current = true;
        reveal(el);
        setTimeout(() => (programmatic.current = false), 400);
      });
    };
    jump();
    awareness.on('change', jump);
    // Any deliberate action of your own stops following.
    const userAction = (e: Event) => {
      if (e.type === 'scroll' && programmatic.current) return;
      if (e instanceof KeyboardEvent && e.key !== 'Escape' && (e.metaKey || e.ctrlKey)) return; // shortcuts are fine
      setTarget(null);
    };
    const opts = { capture: true, passive: true } as const;
    window.addEventListener('wheel', userAction, opts);
    window.addEventListener('touchmove', userAction, opts);
    root.addEventListener('pointerdown', userAction, opts);
    root.addEventListener('keydown', userAction, opts);
    const onEsc = (e: KeyboardEvent) => e.key === 'Escape' && setTarget(null);
    window.addEventListener('keydown', onEsc);
    return () => {
      awareness.off('change', jump);
      window.removeEventListener('wheel', userAction, opts);
      window.removeEventListener('touchmove', userAction, opts);
      root.removeEventListener('pointerdown', userAction, opts);
      root.removeEventListener('keydown', userAction, opts);
      window.removeEventListener('keydown', onEsc);
    };
  }, [target, awareness, root]);

  return { id: target?.id ?? null, name: target?.name ?? null, start, stop };
}
