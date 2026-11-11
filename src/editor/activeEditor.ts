// The editor the ribbon acts on: the one last focused on the open page (the document
// editor, or the last-focused canvas box). Editors register themselves; the ribbon reads it.
import { useSyncExternalStore } from 'react';
import type { Editor } from '@tiptap/react';

let current: Editor | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Make `editor` the one the ribbon acts on. */
export function setActiveEditor(editor: Editor | null) {
  if (current === editor) return;
  current = editor;
  emit();
}

/** Forget `editor` if it is the active one (it was destroyed, or became read-only). */
export function clearActiveEditor(editor: Editor | null) {
  if (editor && current === editor) setActiveEditor(null);
}

export function getActiveEditor(): Editor | null {
  return current && !current.isDestroyed ? current : null;
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useActiveEditor(): Editor | null {
  return useSyncExternalStore(subscribe, getActiveEditor, getActiveEditor);
}
