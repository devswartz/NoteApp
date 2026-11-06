// Table of contents for long pages, and the per-page "full width" setting.
import { useEffect, useState } from 'react';
import type { Editor } from '@tiptap/core';
import type * as Y from 'yjs';

export interface OutlineItem {
  level: number;
  text: string;
  pos: number;
}

/** Headings in document order (empty ones skipped). */
export function headingsOf(editor: Editor): OutlineItem[] {
  const out: OutlineItem[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      const text = node.textContent.trim();
      if (text) out.push({ level: node.attrs.level as number, text, pos });
      return false;
    }
    // Headings only live at the top level or inside containers (callouts, toggles).
    return node.isBlock && !node.isTextblock;
  });
  return out;
}

export function useHeadings(editor: Editor | null): OutlineItem[] {
  const [items, setItems] = useState<OutlineItem[]>([]);
  useEffect(() => {
    if (!editor) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      clearTimeout(t);
      t = setTimeout(() => !editor.isDestroyed && setItems(headingsOf(editor)), 150);
    };
    update();
    editor.on('update', update);
    return () => {
      clearTimeout(t);
      editor.off('update', update);
    };
  }, [editor]);
  return items;
}

/** The shared Y.Doc behind the editor (from the Collaboration extension). */
function docOf(editor: Editor): Y.Doc | null {
  const ext = editor.extensionManager.extensions.find((e) => e.name === 'collaboration');
  return (ext?.options as { document?: Y.Doc } | undefined)?.document ?? null;
}

/**
 * A per-page setting stored in the page's Yjs doc (map "meta"), so it syncs to
 * collaborators and works offline without a schema change.
 */
export function usePageSetting<T>(editor: Editor | null, key: string, fallback: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(fallback);
  useEffect(() => {
    const doc = editor && docOf(editor);
    if (!doc) return;
    const meta = doc.getMap('meta');
    const read = () => setValue(meta.has(key) ? (meta.get(key) as T) : fallback);
    read();
    meta.observe(read);
    return () => meta.unobserve(read);
  }, [editor, key]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (v: T) => {
    const doc = editor && docOf(editor);
    if (doc) doc.getMap('meta').set(key, v);
    else setValue(v);
  };
  return [value, set];
}

/** Floating outline next to the page; highlights the section in view. */
export function Outline({ editor, scroller }: { editor: Editor; scroller: HTMLElement | null }) {
  const items = useHeadings(editor);
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (!scroller || items.length < 3) return;
    const onScroll = () => {
      const top = scroller.getBoundingClientRect().top + 96;
      let current = 0;
      items.forEach((h, i) => {
        const el = editor.view.nodeDOM(h.pos) as HTMLElement | null;
        if (el && el.getBoundingClientRect().top <= top) current = i;
      });
      setActive(current);
    };
    onScroll();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [scroller, items, editor]);

  if (items.length < 3) return null;
  const minLevel = Math.min(...items.map((h) => h.level));
  const go = (h: OutlineItem) => {
    const el = editor.view.nodeDOM(h.pos) as HTMLElement | null;
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    editor.chain().setTextSelection(h.pos + 1).run();
  };
  return (
    <div className="page-toc-rail" aria-hidden={false}>
      <nav className="page-toc" aria-label="On this page">
        <div className="page-toc-title">On this page</div>
        {items.map((h, i) => (
          <button
            key={`${h.pos}-${i}`}
            type="button"
            className={`page-toc-item ${i === active ? 'is-active' : ''}`}
            style={{ paddingLeft: 8 + (h.level - minLevel) * 12 }}
            onClick={() => go(h)}
            title={h.text}
          >
            {h.text}
          </button>
        ))}
      </nav>
    </div>
  );
}
