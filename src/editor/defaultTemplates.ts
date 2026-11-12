// Section default templates and "New page from template" on the client.
//
// A page made with the app's New page (sidebar, ribbon, Ctrl+N, Notes overview) asks the server
// for the section's default template (`template: 'default'`); "New page from template" names one.
// The server only remembers it on the page (pages.pending_template_id). When the page opens, its
// creator's client claims it (POST /pages/:id/pending-template, a compare-and-clear, so two
// clients never both fill it), inserts the content through the canvas like any template (so
// Ctrl+Z takes it back), and offers "Start blank". Imports, quick add, the share extension and
// copies never ask for a template, so they stay as they are.
import type { JSONContent } from '@tiptap/core';
import * as Y from 'yjs';
import { api, patch, post } from '../api.ts';
import { deleteTask, errorToast, toast, useStore } from '../store.ts';
import { BOXES_KEY, boxField, readPageSettings, setPageSettings } from '../../shared/pageDoc.ts';
import type { PendingTemplateUse, TemplateUse } from '../../shared/types.ts';
import { applyTemplateSettings, documentAsBox, pageSchema, templateBoxes, writeBoxes, type CanvasHandle } from './canvasDoc.ts';

// ── {date} and {time} ──

/** "Thursday, November 12, 2026" in the user's locale. */
export const longDate = (d: Date) => d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
export const shortTime = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** Replace {date} and {time} in a string. */
export function fillPlaceholderText(s: string, now = new Date()): string {
  if (!s.includes('{')) return s;
  return s.replace(/\{date\}/gi, longDate(now)).replace(/\{time\}/gi, shortTime(now));
}

/** Replace {date} and {time} in every text node of a template's JSON. */
export function fillPlaceholders<T extends JSONContent>(node: T, now = new Date()): T {
  const out: JSONContent = { ...node };
  if (typeof node.text === 'string') out.text = fillPlaceholderText(node.text, now);
  if (Array.isArray(node.content)) out.content = node.content.map((c) => fillPlaceholders(c, now));
  return out as T;
}

// ── Inserting a template's content ──

export interface Inserted {
  boxIds: string[];
  /** What the page had before, so "Start blank" can put it back. */
  before: { title: string; icon: string | null; settings: ReturnType<typeof readPageSettings> };
  titleSet: string | null;
  iconSet: string | null;
}

/** Sets the page's title and icon from a template if the page doesn't have them yet; returns what was set. */
export function fillMeta(pageId: string, title: string, icon: string | null): { title: string | null; icon: string | null } {
  const meta = useStore.getState().tree.pages.find((p) => p.id === pageId);
  const changes: { title?: string; icon?: string } = {};
  if (!meta?.title && title) changes.title = title;
  if (!meta?.icon && icon) changes.icon = icon;
  if (Object.keys(changes).length) {
    useStore.setState((s) => ({ tree: { ...s.tree, pages: s.tree.pages.map((p) => (p.id === pageId ? { ...p, ...changes } : p)) } }));
    // The server refuses it if the page already has a title/icon (a page not in our tree, e.g. a shared one, must not be filled in blindly).
    patch(`/pages/${pageId}`, { ...changes, ...(changes.title !== undefined ? { titleWas: meta?.title ?? '' } : {}), ...(changes.icon !== undefined ? { iconWas: meta?.icon ?? null } : {}) }).catch(errorToast);
  }
  return { title: changes.title ?? null, icon: changes.icon ?? null };
}

/** Write what POST /templates/:id/use (or the pending claim) returned into the page's doc. */
export function insertTemplateUse(doc: Y.Doc, pageId: string, r: TemplateUse, fallbackIcon: string | null, now = new Date()): Inserted {
  const meta = useStore.getState().tree.pages.find((p) => p.id === pageId);
  const before = { title: meta?.title ?? '', icon: meta?.icon ?? null, settings: readPageSettings(doc) };
  const content = fillPlaceholders(r.content as JSONContent, now);
  const boxIds = writeBoxes(doc, pageSchema(pageId), r.kind === 'canvas' ? templateBoxes(content) : [documentAsBox(content)]);
  applyTemplateSettings(doc, content);
  const set = fillMeta(pageId, fillPlaceholderText(r.title, now), r.icon ?? fallbackIcon);
  return { boxIds, before, titleSet: set.title, iconSet: set.icon };
}

/** Take a just-filled page back to empty: its boxes, the tasks the template made, and the title / icon / settings it set. */
export function startBlank(doc: Y.Doc, pageId: string, ins: Inserted, taskIds: string[]) {
  const map = doc.getMap<unknown>(BOXES_KEY);
  doc.transact(() => {
    for (const id of ins.boxIds) {
      if (!map.has(id)) continue;
      map.delete(id);
      const frag = doc.getXmlFragment(boxField(id));
      if (frag.length) frag.delete(0, frag.length);
    }
  });
  setPageSettings(doc, ins.before.settings);
  for (const id of taskIds) if (useStore.getState().tasks[id]) void deleteTask(id);
  const meta = useStore.getState().tree.pages.find((p) => p.id === pageId);
  const changes: { title?: string; icon?: string | null } = {};
  if (ins.titleSet !== null && meta?.title === ins.titleSet) changes.title = ins.before.title;
  if (ins.iconSet !== null && meta?.icon === ins.iconSet) changes.icon = ins.before.icon;
  if (Object.keys(changes).length) {
    useStore.setState((s) => ({ tree: { ...s.tree, pages: s.tree.pages.map((p) => (p.id === pageId ? { ...p, ...changes } : p)) } }));
    patch(`/pages/${pageId}`, changes).catch(errorToast);
  }
}

// ── New pages ──

export interface NewPage {
  id: string;
  pendingTemplate: { id: string; name: string } | null;
}

/**
 * Make a page in `sectionId` the way the app's New page does: from the section's default template
 * ('default', the usual), from a given template, or blank (null).
 */
export async function createPageIn(sectionId: string, template: 'default' | string | null = 'default'): Promise<NewPage> {
  const r = await post<NewPage>(`/sections/${sectionId}/pages`, { title: '', ...(template ? { template } : {}) });
  const user = useStore.getState().user;
  // Show it in the tree at once (the live event refreshes it with the real values).
  useStore.setState((s) =>
    s.tree.pages.some((p) => p.id === r.id)
      ? s
      : {
          tree: {
            ...s.tree,
            pages: [...s.tree.pages, { id: r.id, sectionId, title: '', icon: null, kind: 'canvas', position: 1e9, updatedAt: new Date().toISOString(), updatedBy: user?.id ?? null }],
          },
        },
  );
  return { id: r.id, pendingTemplate: r.pendingTemplate ?? null };
}

const claimed = new Set<string>();

/**
 * Fill a just-created page from its pending template, once. Call when the page is open, synced and
 * editable. If the canvas already has content (someone typed first), the pending template is dropped.
 */
export async function fillPendingTemplate(canvas: CanvasHandle, pageId: string) {
  if (claimed.has(pageId)) return;
  claimed.add(pageId);
  const empty = canvas.doc.getMap(BOXES_KEY).size === 0;
  try {
    const r = await post<PendingTemplateUse | null>(`/pages/${pageId}/pending-template`, empty ? {} : { discard: true });
    if (!r) return;
    const ins = insertTemplateUse(canvas.doc, pageId, r, null);
    toast(`Started from ${r.name}`, {
      action: { label: 'Start blank', run: () => startBlank(canvas.doc, pageId, ins, r.taskIds) },
    });
  } catch (e) {
    claimed.delete(pageId);
    errorToast(e);
  }
}

// ── The section's default ──

/** Set a section's default template: a template id, 'none' (don't inherit), or null (inherit the parent's). */
export async function setSectionDefaultTemplate(sectionId: string, templateId: string | 'none' | null) {
  await api(`/sections/${sectionId}/default-template`, { method: 'PUT', json: { templateId } });
  useStore.setState((s) => ({
    tree: {
      ...s.tree,
      sections: s.tree.sections.map((x) =>
        x.id === sectionId ? { ...x, defaultTemplateId: templateId === 'none' ? null : templateId, noDefaultTemplate: templateId === 'none' } : x,
      ),
    },
  }));
}
