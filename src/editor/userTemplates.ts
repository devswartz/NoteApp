// User templates on the client: the list for the open workspace, plus save / rename / delete.
// (Inserting one lives in TemplatePicker.tsx, next to the built-ins, and goes through the editor.)
import type { Editor } from '@tiptap/core';
import { create } from 'zustand';
import { del, get, patch, post } from '../api.ts';
import { useStore } from '../store.ts';
import type { TemplateMeta } from '../../shared/types.ts';

interface UserTemplatesState {
  wsId: string | null;
  items: TemplateMeta[];
  loaded: boolean;
}

export const useUserTemplates = create<UserTemplatesState>(() => ({ wsId: null, items: [], loaded: false }));

let latest = 0;
/** (Re)load the workspace's templates. Safe to call often (live events, opening the picker). */
export async function loadUserTemplates(wsId = useStore.getState().wsId) {
  if (!wsId) return;
  const n = ++latest;
  try {
    const items = await get<TemplateMeta[]>(`/workspaces/${wsId}/templates`);
    if (n === latest) useUserTemplates.setState({ wsId, items, loaded: true });
  } catch {
    /* offline or no access: keep what we have; the picker just shows the built-ins */
  }
}

/** Snapshot the live editor content as a template. The server copies tasks and attachments. */
export async function saveAsTemplate(editor: Editor, pageId: string, name: string, icon?: string | null) {
  const t = await post<TemplateMeta>(`/pages/${pageId}/templates`, { name, icon: icon || undefined, content: editor.getJSON() });
  void loadUserTemplates();
  return t;
}

export async function renameTemplate(id: string, name: string) {
  const t = await patch<TemplateMeta>(`/templates/${id}`, { name });
  useUserTemplates.setState((s) => ({ items: s.items.map((x) => (x.id === id ? t : x)) }));
}

export async function deleteTemplate(id: string) {
  await del(`/templates/${id}`);
  useUserTemplates.setState((s) => ({ items: s.items.filter((x) => x.id !== id) }));
}
