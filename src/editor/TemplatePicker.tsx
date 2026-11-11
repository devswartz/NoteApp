// "Start with a template" on an empty page, plus applyTemplate() for other entry points.
// The workspace's templates tied to this page's section (or a parent section) come first, under
// "Templates for this section"; then the built-ins and the templates offered everywhere. Templates
// tied only to other sections aren't shown. Each user template has rename, "Available in…" and delete.
// Every page is a canvas: the built-ins come as boxes, a canvas template's boxes keep their places,
// and a template saved from a document page (before pages were all canvases) becomes one wide box.
import { useEffect, useState } from 'react';
import * as Y from 'yjs';
import type { Editor, JSONContent } from '@tiptap/core';
import { FolderTree, Pencil, Trash2 } from 'lucide-react';
import { patch, post } from '../api.ts';
import { errorToast, toast, useStore } from '../store.ts';
import { confirmDialog, promptDialog } from '../components/shell/dialogs.tsx';
import { TEMPLATES, type PageTemplate } from './templates.ts';
import { deleteTemplate, loadUserTemplates, renameTemplate, setTemplateSections, useUserTemplates } from './userTemplates.ts';
import { templateDialog } from './TemplateDialog.tsx';
import { templateOffer } from '../../shared/sections.ts';
import type { TemplateMeta, TemplateUse } from '../../shared/types.ts';
import { BOXES_KEY } from '../../shared/pageDoc.ts';
import { applyTemplateSettings, documentAsBox, editorDoc, pageSchema, templateBoxes, writeBoxes, type CanvasHandle } from './canvasDoc.ts';

/** Where a template goes: the page's document editor, or its canvas. */
export type TemplateTarget = { editor: Editor; canvas?: null } | { editor?: null; canvas: CanvasHandle };

/** A stable empty list: a selector returning a fresh [] each time makes the store re-render forever. */
const NONE: TemplateMeta[] = [];

/** Sets the page's title and icon from a template if the page doesn't have them yet. */
function fillMeta(pageId: string, title: string, icon: string | null) {
  const meta = useStore.getState().tree.pages.find((p) => p.id === pageId);
  const changes: { title?: string; icon?: string } = {};
  if (!meta?.title && title) changes.title = title;
  if (!meta?.icon && icon) changes.icon = icon;
  if (!Object.keys(changes).length) return;
  useStore.setState((s) => ({ tree: { ...s.tree, pages: s.tree.pages.map((p) => (p.id === pageId ? { ...p, ...changes } : p)) } }));
  patch(`/pages/${pageId}`, changes).catch(errorToast);
}

/**
 * Fill a page from a template: replaces the (empty) document, and sets the title and icon
 * if the page doesn't have them yet. Other areas can call this after creating a page:
 *   applyTemplate(editor, pageId, templateById('meeting')!)
 */
export function applyTemplate(editor: Editor, pageId: string, t: PageTemplate, now = new Date()) {
  editor.chain().setContent(t.content(now)).focus('start').run();
  fillMeta(pageId, t.title(now), t.icon);
}

/** Fill an empty canvas from a built-in template's canvas version. */
export function applyCanvasTemplate(canvas: CanvasHandle, t: PageTemplate, now = new Date()) {
  writeBoxes(canvas.doc, pageSchema(canvas.pageId), t.boxes(now));
  fillMeta(canvas.pageId, t.title(now), t.icon);
}

/**
 * Fill a page from one of the workspace's own templates. The server creates brand-new tasks and
 * attachment copies for this page and hands back the content pointing at them; we insert it through
 * the editor exactly like a built-in template (so it syncs like any other edit).
 */
export async function applyUserTemplate(target: TemplateTarget, pageId: string, t: TemplateMeta) {
  const r = await post<TemplateUse>(`/templates/${t.id}/use`, { pageId });
  const content = r.content as JSONContent;
  const schema = pageSchema(pageId);
  const doc = target.canvas ? target.canvas.doc : editorDoc(target.editor!);
  if (!doc) return;
  writeBoxes(doc, schema, r.kind === 'canvas' ? templateBoxes(content) : [documentAsBox(content)]);
  applyTemplateSettings(doc, content);
  fillMeta(pageId, r.title, r.icon ?? t.icon);
}

/** True while the canvas has no boxes. */
function useCanvasEmpty(doc: Y.Doc | null) {
  const [empty, setEmpty] = useState(() => !doc || doc.getMap(BOXES_KEY).size === 0);
  useEffect(() => {
    if (!doc) return;
    const map = doc.getMap(BOXES_KEY);
    const on = () => setEmpty(map.size === 0);
    on();
    map.observe(on);
    return () => map.unobserve(on);
  }, [doc]);
  return empty;
}

/** True while the document has nothing in it but empty paragraphs. */
function useIsEmpty(editor: Editor | null | undefined) {
  const [empty, setEmpty] = useState(() => !!editor?.isEmpty);
  useEffect(() => {
    if (!editor) return;
    const on = () => setEmpty(editor.isEmpty);
    on();
    editor.on('update', on);
    editor.on('create', on);
    return () => {
      editor.off('update', on);
      editor.off('create', on);
    };
  }, [editor]);
  return empty;
}

export function TemplatePicker({ pageId, ...target }: TemplateTarget & { pageId: string }) {
  const { editor, canvas } = target;
  const docEmpty = useIsEmpty(editor);
  const canvasEmpty = useCanvasEmpty(canvas?.doc ?? null);
  const empty = canvas ? canvasEmpty : docEmpty;
  const wsId = useStore((s) => s.wsId);
  const mine = useUserTemplates((s) => (s.wsId === wsId ? s.items : NONE));
  const tree = useStore((s) => s.tree);
  const sectionId = tree.pages.find((p) => p.id === pageId)?.sectionId;
  const [busy, setBusy] = useState<string | null>(null);
  const show = empty && (canvas ? true : !!editor?.isEditable);
  useEffect(() => {
    if (show) void loadUserTemplates(wsId);
  }, [show, wsId]);
  if (!show) return null;

  const use = (t: TemplateMeta) => {
    if (busy) return;
    setBusy(t.id);
    applyUserTemplate(target, pageId, t)
      .catch(errorToast)
      .finally(() => setBusy(null));
  };
  const rename = async (t: TemplateMeta) => {
    const name = await promptDialog({ title: 'Rename template', label: 'Name', initial: t.name, confirmLabel: 'Rename' });
    if (name && name !== t.name) renameTemplate(t.id, name).then(() => toast('Template renamed')).catch(errorToast);
  };
  const remove = async (t: TemplateMeta) => {
    const ok = await confirmDialog({
      title: `Delete template “${t.name}”?`,
      message: 'Pages already made from it keep their content. This can’t be undone.',
      confirmLabel: 'Delete template',
      danger: true,
    });
    if (ok) deleteTemplate(t.id).then(() => toast('Template deleted')).catch(errorToast);
  };
  const scope = async (t: TemplateMeta) => {
    const r = await templateDialog({ title: `Where “${t.name}” is offered`, sections: t.sections, confirmLabel: 'Save' });
    if (r) setTemplateSections(t.id, r.sections).then(() => toast('Template updated')).catch(errorToast);
  };
  // Templates tied to this section come first; ones tied to other sections only aren't offered here.
  const forSection = mine.filter((t) => templateOffer(t, sectionId, tree) === 'section');
  const others = mine.filter((t) => templateOffer(t, sectionId, tree) === 'everywhere');

  const userRow = (list: TemplateMeta[], testId: string) => (
    <div className="template-picker-row" data-testid={testId}>
      {list.map((t) => (
        <div key={t.id} className="template-card-wrap" data-template-id={t.id}>
          <button
            type="button"
            className="template-card template-card-user"
            disabled={busy !== null}
            title={t.visibility === 'private' ? 'Only you can see this template' : 'Shared with the workspace'}
            onClick={() => use(t)}
          >
            <span className="template-icon">{t.icon || '📋'}</span>
            {t.kind === 'canvas' && <span className="sr-only"> (canvas)</span>}
            <span className="template-name">{t.name}</span>
          </button>
          {t.canManage && (
            <>
              <button type="button" className="template-act" aria-label={`Rename template ${t.name}`} title="Rename" onClick={() => void rename(t)}>
                <Pencil size={13} />
              </button>
              <button type="button" className="template-act" aria-label={`Choose sections for template ${t.name}`} title="Available in…" onClick={() => void scope(t)}>
                <FolderTree size={13} />
              </button>
              <button type="button" className="template-act" aria-label={`Delete template ${t.name}`} title="Delete" onClick={() => void remove(t)}>
                <Trash2 size={13} />
              </button>
            </>
          )}
        </div>
      ))}
    </div>
  );

  return (
    <div className="template-picker" aria-label="Start with a template">
      <span className="template-picker-label">Start with a template, or just type</span>
      {forSection.length > 0 && (
        <>
          <span className="template-picker-label template-picker-label-2">Templates for this section</span>
          {userRow(forSection, 'section-templates')}
          <span className="template-picker-label template-picker-label-2">Other templates</span>
        </>
      )}
      <div className="template-picker-row">
        {TEMPLATES.map((t) => (
          <button
            key={t.id}
            type="button"
            className="template-card"
            title={t.description}
            onClick={() => (canvas ? applyCanvasTemplate(canvas, t) : editor && applyTemplate(editor, pageId, t))}
          >
            <span className="template-icon">{t.icon}</span>
            <span className="template-name">{t.name}</span>
          </button>
        ))}
      </div>
      {others.length > 0 && (
        <>
          {forSection.length === 0 && <span className="template-picker-label template-picker-label-2">Your templates</span>}
          {userRow(others, 'user-templates')}
        </>
      )}
    </div>
  );
}
