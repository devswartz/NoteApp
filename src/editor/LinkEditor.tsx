// Inline link editor: ⌘K (with text selected or inside a link) or the toolbar's link button.
// Two fields, like OneNote's "Text to display" + "Address".
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import type { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { ExternalLink, Link2Off } from 'lucide-react';
import { platform } from '../platform/index.ts';
import { closeUndoGroup } from './pageUndo.ts';

interface LinkState {
  editor: Editor | null;
  /** The text range being linked, captured when the editor opened (focus moves to the inputs). Empty when inserting. */
  range: { from: number; to: number } | null;
}
const useLink = create<LinkState>(() => ({ editor: null, range: null }));

/**
 * Open the link editor for the current selection. Returns false if there's nothing to link.
 * With `insert`, an empty selection outside a link opens it to insert a new link at the cursor.
 */
export function openLinkEditor(editor: Editor, opts: { insert?: boolean } = {}): boolean {
  if (!editor.isEditable) return false;
  if (editor.state.selection.empty && !editor.isActive('link') && !opts.insert) return false;
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

/**
 * Give `range` the text `text`, linked to `href` (null: not linked), in one transaction (one undo step).
 * Unchanged text keeps its per-character marks; new text takes the marks at the range start.
 */
export function applyLink(editor: Editor, range: { from: number; to: number }, text: string, href: string | null) {
  const { state } = editor;
  const linkType = state.schema.marks.link;
  if (!linkType || !text) return;
  const { from, to } = range;
  const original = state.doc.textBetween(from, to, ' ');
  const tr = state.tr;
  let end = to;
  if (text === original && from < to) {
    tr.removeMark(from, to, linkType);
    if (href) tr.addMark(from, to, linkType.create({ href }));
  } else {
    const startMarks =
      from < to ? (state.doc.nodeAt(from)?.marks ?? state.doc.resolve(from).marks()) : (state.storedMarks ?? state.doc.resolve(from).marks());
    let marks = linkType.removeFromSet(startMarks);
    if (href) marks = linkType.create({ href }).addToSet(marks);
    if (from < to) tr.replaceWith(from, to, state.schema.text(text, marks));
    else tr.insert(from, state.schema.text(text, marks));
    end = from + text.length;
  }
  if (from < to) {
    // The edited text stays selected, as before.
    tr.setSelection(TextSelection.create(tr.doc, from, end));
  } else {
    // A new link: the cursor goes after it, and what's typed next isn't linked.
    tr.setSelection(TextSelection.create(tr.doc, end));
    tr.removeStoredMark(linkType);
  }
  // Its own undo step: typing just before it (within Yjs's half-second grouping) would otherwise undo with it.
  closeUndoGroup(editor);
  editor.view.dispatch(tr.scrollIntoView());
  closeUndoGroup(editor);
  editor.commands.focus();
}

export function LinkEditorView() {
  const editor = useLink((s) => s.editor);
  if (!editor) return null;
  return <LinkEditorInner editor={editor} />;
}

function LinkEditorInner({ editor }: { editor: Editor }) {
  const range = useLink((s) => s.range);
  const current = (editor.getAttributes('link').href as string | undefined) ?? '';
  const [initialText] = useState(() => (range && range.from < range.to ? editor.state.doc.textBetween(range.from, range.to, ' ') : ''));
  const [text, setText] = useState(initialText);
  const [value, setValue] = useState(current);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const textInput = useRef<HTMLInputElement>(null);
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
    const width = box.current?.offsetWidth ?? 360;
    setPos({ top: Math.max(a.bottom, b.bottom) + 8, left: Math.min(Math.max(8, a.left), window.innerWidth - width - 8) });
    // An existing link or selected text: straight to the address; a new link with nothing selected: its text first.
    const first = current || initialText ? input.current : textInput.current;
    first?.focus();
    first?.select();
  }, [editor]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const apply = () => {
    const href = normaliseUrl(value);
    const r = range ?? editor.state.selection;
    // Empty text: the address is the text (with no address either, the text stays as it was).
    const label = text || (href ? value.trim() : initialText);
    close(false);
    if (label) applyLink(editor, { from: r.from, to: r.to }, label, href);
    else editor.commands.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      apply();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  return createPortal(
    <div ref={box} className="popover link-editor" style={pos ?? { top: -9999, left: -9999 }}>
      <div className="link-field">
        <span className="link-label" aria-hidden>
          Text
        </span>
        <input
          ref={textInput}
          className="input link-input link-text-input"
          aria-label="Text to display"
          placeholder="Text to display"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className="link-field">
        <span className="link-label" aria-hidden>
          Address
        </span>
        <input
          ref={input}
          className="input link-input"
          aria-label="Address"
          placeholder="Paste or type a link…"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
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
      </div>
    </div>,
    document.body,
  );
}
