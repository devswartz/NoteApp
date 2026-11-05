// "Start with a template" on an empty page, plus applyTemplate() for other entry points.
import { useEffect, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { patch } from '../api.ts';
import { errorToast, useStore } from '../store.ts';
import { TEMPLATES, type PageTemplate } from './templates.ts';

/**
 * Fill a page from a template: replaces the (empty) document, and sets the title and icon
 * if the page doesn't have them yet. Other areas can call this after creating a page:
 *   applyTemplate(editor, pageId, templateById('meeting')!)
 */
export function applyTemplate(editor: Editor, pageId: string, t: PageTemplate, now = new Date()) {
  editor.chain().setContent(t.content(now)).focus('start').run();
  const meta = useStore.getState().tree.pages.find((p) => p.id === pageId);
  const changes: { title?: string; icon?: string } = {};
  if (!meta?.title) changes.title = t.title(now);
  if (!meta?.icon) changes.icon = t.icon;
  if (!Object.keys(changes).length) return;
  useStore.setState((s) => ({ tree: { ...s.tree, pages: s.tree.pages.map((p) => (p.id === pageId ? { ...p, ...changes } : p)) } }));
  patch(`/pages/${pageId}`, changes).catch(errorToast);
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
  if (!empty || !editor.isEditable) return null;
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
    </div>
  );
}
