// User templates on the client: the list for the open workspace, plus save / rename / delete.
// (Inserting one lives in TemplatePicker.tsx, next to the built-ins, and goes through the editor.)
import type { Editor } from '@tiptap/core';
import { create } from 'zustand';
import { del, get, patch, post } from '../api.ts';
import { useStore } from '../store.ts';
import type { TemplateMeta } from '../../shared/types.ts';
import { canvasTemplateJSON, pageSchema, type CanvasHandle } from './canvasDoc.ts';

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

/** Load the workspace's templates if they aren't loaded yet (section menus, the default-template icon). */
export function ensureUserTemplates(wsId = useStore.getState().wsId) {
  const s = useUserTemplates.getState();
  if (wsId && (s.wsId !== wsId || !s.loaded) && requested !== wsId) {
    requested = wsId;
    void loadUserTemplates(wsId);
  }
}
let requested: string | null = null;

/**
 * Snapshot the live content as a template: the document editor's, or a canvas's boxes (kept as a
 * canvas template, so using it makes a canvas). The server copies tasks and attachments.
 */
export async function saveAsTemplate(source: Editor | CanvasHandle, pageId: string, name: string, icon?: string | null, sections?: TemplateMeta['sections']) {
  const canvas = 'addBox' in source;
  const content = canvas ? canvasTemplateJSON(source.doc, pageSchema(pageId)) : source.getJSON();
  const t = await post<TemplateMeta>(`/pages/${pageId}/templates`, { name, icon: icon || undefined, content, kind: canvas ? 'canvas' : 'document', sections });
  void loadUserTemplates();
  return t;
}

/** Change the sections a template is offered in ([] = everywhere). */
export async function setTemplateSections(id: string, sections: TemplateMeta['sections']) {
  const t = await patch<TemplateMeta>(`/templates/${id}`, { sections });
  useUserTemplates.setState((s) => ({ items: s.items.map((x) => (x.id === id ? t : x)) }));
}

export async function renameTemplate(id: string, name: string) {
  const t = await patch<TemplateMeta>(`/templates/${id}`, { name });
  useUserTemplates.setState((s) => ({ items: s.items.map((x) => (x.id === id ? t : x)) }));
}

export async function deleteTemplate(id: string) {
  await del(`/templates/${id}`);
  useUserTemplates.setState((s) => ({ items: s.items.filter((x) => x.id !== id) }));
}
