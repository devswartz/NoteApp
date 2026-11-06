// "Start with a template" on an empty page, plus applyTemplate() for other entry points.
// Built-in templates are listed first; the workspace's own templates (saved from the page menu) follow,
// each with rename and delete.
import { useEffect, useState } from 'react';
import type { Editor, JSONContent } from '@tiptap/core';
import { Pencil, Trash2 } from 'lucide-react';
import { patch, post } from '../api.ts';
import { errorToast, toast, useStore } from '../store.ts';
import { confirmDialog, promptDialog } from '../components/shell/dialogs.tsx';
import { TEMPLATES, type PageTemplate } from './templates.ts';
import { deleteTemplate, loadUserTemplates, renameTemplate, useUserTemplates } from './userTemplates.ts';
import type { TemplateMeta, TemplateUse } from '../../shared/types.ts';

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

/**
 * Fill a page from one of the workspace's own templates. The server creates brand-new tasks and
 * attachment copies for this page and hands back the content pointing at them; we insert it through
 * the editor exactly like a built-in template (so it syncs like any other edit).
 */
export async function applyUserTemplate(editor: Editor, pageId: string, t: TemplateMeta) {
  const r = await post<TemplateUse>(`/templates/${t.id}/use`, { pageId });
  editor.chain().setContent(r.content as JSONContent).focus('start').run();
  fillMeta(pageId, r.title, r.icon ?? t.icon);
}

/** True while the document has nothing in it but empty paragraphs. */
function useIsEmpty(editor: Editor) {
  const [empty, setEmpty] = useState(() => editor.isEmpty);
  useEffect(() => {
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

export function TemplatePicker({ editor, pageId }: { editor: Editor; pageId: string }) {
  const empty = useIsEmpty(editor);
  const wsId = useStore((s) => s.wsId);
  const mine = useUserTemplates((s) => (s.wsId === wsId ? s.items : NONE));
  const [busy, setBusy] = useState<string | null>(null);
  const show = empty && editor.isEditable;
  useEffect(() => {
    if (show) void loadUserTemplates(wsId);
  }, [show, wsId]);
  if (!show) return null;

  const use = (t: TemplateMeta) => {
    if (busy) return;
    setBusy(t.id);
    applyUserTemplate(editor, pageId, t)
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

  return (
    <div className="template-picker" aria-label="Start with a template">
      <span className="template-picker-label">Start with a template, or just type</span>
      <div className="template-picker-row">
        {TEMPLATES.map((t) => (
          <button key={t.id} type="button" className="template-card" title={t.description} onClick={() => applyTemplate(editor, pageId, t)}>
            <span className="template-icon">{t.icon}</span>
            <span className="template-name">{t.name}</span>
          </button>
        ))}
      </div>
      {mine.length > 0 && (
        <>
          <span className="template-picker-label template-picker-label-2">Your templates</span>
          <div className="template-picker-row" data-testid="user-templates">
            {mine.map((t) => (
              <div key={t.id} className="template-card-wrap" data-template-id={t.id}>
                <button
                  type="button"
                  className="template-card template-card-user"
                  disabled={busy !== null}
                  title={t.visibility === 'private' ? 'Only you can see this template' : 'Shared with the workspace'}
                  onClick={() => use(t)}
                >
                  <span className="template-icon">{t.icon || '📋'}</span>
                  <span className="template-name">{t.name}</span>
                </button>
                {t.canManage && (
                  <>
                    <button type="button" className="template-act" aria-label={`Rename template ${t.name}`} title="Rename" onClick={() => void rename(t)}>
                      <Pencil size={13} />
                    </button>
                    <button type="button" className="template-act" aria-label={`Delete template ${t.name}`} title="Delete" onClick={() => void remove(t)}>
                      <Trash2 size={13} />
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
