// Right-click on a selection: a small menu with "Print selection" (and Copy). It only takes the right-click over
// something selected: picked lines, picked boxes, or a text selection of more than one word. Everywhere else the
// browser's own menu stays, so spelling suggestions still work: a web page can't add to the browser's menu, so
// right-clicking a single selected word (the usual way to correct it) is left alone too.
import { useEffect, useRef } from 'react';
import { Copy, Printer } from 'lucide-react';
import { MenuItem, useContextMenu } from '../components/ui.tsx';
import { toast } from '../store.ts';
import { printSelectionOnly } from './exportPage.ts';
import { selectionEditor, useBoxSelection } from './boxSelection.ts';
import { linePicks } from './linePicks.ts';

/** The text "Copy" takes: picked lines, else picked boxes' text, else the selected text. */
function selectionText(pageId: string): string {
  const lines = linePicks.text(pageId);
  if (lines) return lines;
  const ed = selectionEditor(pageId);
  const picked = useBoxSelection.getState();
  if (picked.pageId === pageId && picked.ids.length) {
    return picked.ids
      .map((id) => document.querySelector<HTMLElement>(`.canvas-box[data-box-id="${CSS.escape(id)}"] .ProseMirror`)?.innerText.trim() ?? '')
      .filter(Boolean)
      .join('\n\n');
  }
  if (!ed || ed.isDestroyed) return '';
  const { from, to } = ed.state.selection;
  return ed.state.doc.textBetween(from, to, '\n', ' ');
}

/** Did this right-click land on something that "Print selection" would print? */
function onSelection(e: MouseEvent, pageId: string): boolean {
  const t = e.target as HTMLElement | null;
  if (!t?.closest) return false;
  if (t.closest('.is-line-picked') || t.closest('.canvas-box.is-picked')) return true;
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
        onSelect={() => {
          const text = selectionText(pageId);
          if (text) void navigator.clipboard?.writeText(text).then(() => toast('Copied'), () => toast('Couldn’t copy'));
        }}
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
    document.addEventListener('contextmenu', onContext);
    return () => document.removeEventListener('contextmenu', onContext);
  }, [pageId]);
  return menu.menu;
}
