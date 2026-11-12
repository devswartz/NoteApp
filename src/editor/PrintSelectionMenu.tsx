// Right-click on a selection: a small menu with "Print selection" (and Copy). It only takes the right-click over
// something selected: picked text, picked boxes, or a text selection of more than one word. Everywhere else the
// browser's own menu stays, so spelling suggestions still work: a web page can't add to the browser's menu, so
// right-clicking a single selected word (the usual way to correct it) is left alone too.
import { useEffect, useRef } from 'react';
import { Copy, Printer } from 'lucide-react';
import { MenuItem, useContextMenu } from '../components/ui.tsx';
import { toast } from '../store.ts';
import { printSelectionOnly } from './exportPage.ts';
import { selectionEditor, useBoxSelection } from './boxSelection.ts';
import { linePicks } from './linePicks.ts';
import { selectionBlocks } from '../print/selectionContent.ts';
import { blocksText } from './boxClipboard.ts';
import { taskLine, writeBlocks } from './clipboardOut.ts';
import { pageSchema } from './canvasDoc.ts';
import type { JSONContent } from '@tiptap/core';

/** What "Copy" takes, as blocks (so lists and formatting survive): picked lines, else picked boxes, else the selection. */
function selectionContent(pageId: string): JSONContent[] {
  const lines = linePicks.orderedBlocks(pageId);
  if (lines.length) return lines;
  const picked = useBoxSelection.getState();
  if (picked.pageId === pageId && picked.ids.length) return linePicks.boxBlocks(pageId, picked.ids);
  const ed = selectionEditor(pageId);
  return ed && !ed.isDestroyed ? selectionBlocks(ed.state.selection) : [];
}

/** Copy the selection to the clipboard as HTML and text; says so. */
function copySelection(pageId: string) {
  const blocks = selectionContent(pageId);
  if (!blocks.length) return;
  void writeBlocks(blocks, pageSchema(pageId), blocksText(blocks, taskLine)).then(() => toast('Copied'), () => toast('Couldn’t copy'));
}

/** Did this right-click land on something that "Print selection" would print? */
function onSelection(e: MouseEvent, pageId: string): boolean {
  const t = e.target as HTMLElement | null;
  if (!t?.closest) return false;
  const hit = linePicks.hit(pageId, t, e.clientX, e.clientY);
  // Picked text or a picked box; or, once something is picked, the live selection too (it prints with the picks).
  if (hit === 'pick' || t.closest('.canvas-box.is-picked') || (hit === 'selection' && linePicks.count(pageId) > 0)) return true;
  const ed = selectionEditor(pageId);
  if (!ed || ed.isDestroyed || ed.state.selection.empty || !ed.view.dom.contains(t)) return false;
  const { from, to } = ed.state.selection;
  const at = ed.view.posAtCoords({ left: e.clientX, top: e.clientY });
  if (!at || at.pos < from || at.pos > to) return false;
  // A single word keeps the browser's menu (spelling suggestions); more than one word or line gets ours. (Trimmed: a
  // double-click can take in the paragraph break after a word, which doesn't make it a multi-line selection.)
  return /\s/.test(ed.state.doc.textBetween(from, to, '\n', ' ').trim());
}

export function PrintSelectionMenu({ pageId }: { pageId: string }) {
  const menu = useContextMenu(() => (
    <div className="menu" role="menu" aria-label="Selection">
      <MenuItem icon={<Printer size={15} />} onSelect={() => printSelectionOnly()}>
        Print selection
      </MenuItem>
      <MenuItem
        icon={<Copy size={15} />}
        onSelect={() => copySelection(pageId)}
      >
        Copy
      </MenuItem>
    </div>
  ));
  const open = useRef(menu.openAt);
  open.current = menu.openAt;
  useEffect(() => {
    const onContext = (e: MouseEvent) => {
      // Another menu (a box's own options) already took it.
      if (e.defaultPrevented || !onSelection(e, pageId)) return;
      e.preventDefault();
      open.current(e.clientX, e.clientY);
    };
    // Ctrl/Cmd+C with text picked copies every picked range (the browser would copy only the live selection).
    const onCopy = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'c' || !linePicks.count(pageId)) return;
      if (!linePicks.orderedBlocks(pageId).length) return;
      e.preventDefault();
      copySelection(pageId);
    };
    document.addEventListener('contextmenu', onContext);
    window.addEventListener('keydown', onCopy, true);
    return () => {
      document.removeEventListener('contextmenu', onContext);
      window.removeEventListener('keydown', onCopy, true);
    };
  }, [pageId]);
  return menu.menu;
}
