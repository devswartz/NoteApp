// Inline link editor: ⌘K (with text selected or inside a link) or the toolbar's link button.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import type { Editor } from '@tiptap/core';
import { ExternalLink, Link2Off } from 'lucide-react';
import { platform } from '../platform/index.ts';

interface LinkState {
  editor: Editor | null;
  /** The text range being linked, captured when the editor opened (focus moves to the input). */
  range: { from: number; to: number } | null;
}
const useLink = create<LinkState>(() => ({ editor: null, range: null }));

/** Open the link editor for the current selection. Returns false if there's nothing to link. */
export function openLinkEditor(editor: Editor): boolean {
  if (!editor.isEditable) return false;
  if (editor.state.selection.empty && !editor.isActive('link')) return false;
  if (editor.isActive('link')) editor.chain().extendMarkRange('link').run();
  const { from, to } = editor.state.selection;
  useLink.setState({ editor, range: { from, to } });
  return true;
}

/** Normalise what people type: "example.com" → "https://example.com". */
export function normaliseUrl(raw: string): string | null {
  const url = raw.trim();
  if (!url) return null;
  if (/^(https?:|mailto:|tel:|notivelo:)/i.test(url)) return url;
  if (/^\/|^#/.test(url)) return url;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(url)) return `mailto:${url}`;
  if (/^(javascript|data|vbscript):/i.test(url)) return null;
  return `https://${url}`;
}

export function LinkEditorView() {
  const editor = useLink((s) => s.editor);
  if (!editor) return null;
  return <LinkEditorInner editor={editor} />;
}

function LinkEditorInner({ editor }: { editor: Editor }) {
  const current = (editor.getAttributes('link').href as string | undefined) ?? '';
  const [value, setValue] = useState(current);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const close = (refocus = true) => {
    useLink.setState({ editor: null, range: null });
    if (refocus) editor.commands.focus();
  };

  useLayoutEffect(() => {
    const { from, to } = editor.state.selection;
    const a = editor.view.coordsAtPos(from);
    const b = editor.view.coordsAtPos(to);
    const width = box.current?.offsetWidth ?? 340;
    setPos({ top: Math.max(a.bottom, b.bottom) + 8, left: Math.min(Math.max(8, a.left), window.innerWidth - width - 8) });
    input.current?.focus();
    input.current?.select();
  }, [editor]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const range = useLink((s) => s.range);
  const apply = () => {
    const href = normaliseUrl(value);
    const chain = editor.chain().focus();
    if (range) chain.setTextSelection(range);
    if (href) chain.setLink({ href });
    else chain.unsetLink();
    chain.run();
    close(false);
  };

  return createPortal(
    <div ref={box} className="popover link-editor" style={pos ?? { top: -9999, left: -9999 }}>
      <input
        ref={input}
        className="input link-input"
        placeholder="Paste or type a link…"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            apply();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            close();
          }
        }}
      />
      {current && (
        <>
          <button type="button" className="btn-ghost icon-btn" title="Open link" onClick={() => platform.openExternal(current)}>
            <ExternalLink size={15} />
          </button>
          <button
            type="button"
            className="btn-ghost icon-btn"
            title="Remove link"
            onClick={() => {
              const chain = editor.chain().focus();
              if (range) chain.setTextSelection(range);
              chain.unsetLink().run();
              close(false);
            }}
          >
            <Link2Off size={15} />
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}
