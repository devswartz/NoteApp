// Table of contents for long pages, and the per-page "full width" setting.
// The outline lists the headings of every text box, in reading order, read from the page's
// Y.Doc (so boxes whose editors aren't mounted yet are included); clicking one mounts its box
// if needed, puts the caret in the heading and scrolls to it.
import { memo, useEffect, useState } from 'react';
import type { Editor } from '@tiptap/core';
import type * as Y from 'yjs';
import { BOXES_KEY, observePageContent, pageHeadings, type PageHeading } from '../../shared/pageDoc.ts';
import type { CanvasHandle } from './canvasDoc.ts';

export interface OutlineItem {
  level: number;
  text: string;
  pos: number;
}

/** Headings of one editor in document order (empty ones skipped). */
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

/** The headings of every box, kept up to date as anyone edits (debounced). */
function usePageHeadings(doc: Y.Doc): PageHeading[] {
  const [items, setItems] = useState<PageHeading[]>(() => pageHeadings(doc));
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      clearTimeout(t);
      t = setTimeout(() => setItems(pageHeadings(doc)), 150);
    };
    update();
    const stop = observePageContent(doc, update);
    const boxes = doc.getMap(BOXES_KEY);
    boxes.observeDeep(update); // boxes moved (reading order) or removed
    return () => {
      clearTimeout(t);
      stop();
      boxes.unobserveDeep(update);
    };
  }, [doc]);
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

/** Where a heading is on screen: the heading itself if its box's editor is mounted, else its box. */
function headingElement(canvas: CanvasHandle, h: PageHeading): HTMLElement | null {
  const box = canvas.boxElement(h.boxId);
  if (!box) return null;
  const shown = [...box.querySelectorAll<HTMLElement>('.ProseMirror h1, .ProseMirror h2, .ProseMirror h3')].filter((el) => el.textContent?.trim());
  return shown[h.index] ?? box;
}

/** Floating outline next to the page; highlights the section in view. */
export const Outline = memo(function Outline({ canvas, scroller }: { canvas: CanvasHandle; scroller: HTMLElement | null }) {
  const items = usePageHeadings(canvas.doc);
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (!scroller || items.length < 3) return;
    // Below the sticky top bar and the ribbon (--ribbon-h, 0 on phones).
    const ribbon = parseFloat(getComputedStyle(scroller).getPropertyValue('--ribbon-h')) || 0;
    const onScroll = () => {
      const top = scroller.getBoundingClientRect().top + 96 + ribbon;
      let current = 0;
      items.forEach((h, i) => {
        const el = headingElement(canvas, h);
        if (el && el.getBoundingClientRect().top <= top) current = i;
      });
      setActive(current);
    };
    onScroll();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [scroller, items, canvas]);

  if (items.length < 3) return null;
  const minLevel = Math.min(...items.map((h) => h.level));
  return (
    <div className="page-toc-rail" aria-hidden={false}>
      <nav className="page-toc" aria-label="On this page">
        <div className="page-toc-title">On this page</div>
        {items.map((h, i) => (
          <button
            key={`${h.boxId}-${h.index}`}
            type="button"
            className={`page-toc-item ${i === active ? 'is-active' : ''}`}
            style={{ paddingLeft: 8 + (h.level - minLevel) * 12 }}
            onClick={() => canvas.revealHeading(h.boxId, h.index)}
            title={h.text}
          >
            {h.text}
          </button>
        ))}
      </nav>
    </div>
  );
});
