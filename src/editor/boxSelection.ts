// The canvas's picked boxes (Ctrl/Cmd+click, OneNote-style) and the box editor whose text
// selection "Print selection" prints. CanvasEditor writes it; the ribbon, the page menu and
// Ctrl+P read it (src/print/print.ts).
import { create } from 'zustand';
import { useEditorState, type Editor } from '@tiptap/react';
import { getActiveEditor, useActiveEditor } from './activeEditor.ts';
import { toggleId } from '../print/selectionContent.ts';
import { useLinePicks } from './linePicks.ts';

interface BoxSelection {
  pageId: string | null;
  /** Picked boxes, in the order they were picked (printing sorts them into reading order). */
  ids: string[];
  /** The last-focused box editor (viewers too: the ribbon's active editor is for editors only). */
  editor: Editor | null;
}

export const useBoxSelection = create<BoxSelection>(() => ({ pageId: null, ids: [], editor: null }));

export const boxSelection = {
  toggle(pageId: string, id: string) {
    const s = useBoxSelection.getState();
    useBoxSelection.setState({ pageId, ids: toggleId(s.pageId === pageId ? s.ids : [], id) });
  },
  /** Select exactly these boxes. */
  set(pageId: string, ids: string[]) {
    useBoxSelection.setState({ pageId, ids });
  },
  clear() {
    if (useBoxSelection.getState().ids.length) useBoxSelection.setState({ ids: [] });
  },
  setEditor(pageId: string, editor: Editor | null) {
    const s = useBoxSelection.getState();
    useBoxSelection.setState(s.pageId === pageId ? { editor } : { pageId, editor, ids: [] });
  },
  /** The page closed: forget its selection. */
  leave(pageId: string) {
    if (useBoxSelection.getState().pageId === pageId) useBoxSelection.setState({ pageId: null, ids: [], editor: null });
  },
};

/** The editor whose text selection prints: the last-focused box, else the ribbon's (a document page). */
export function selectionEditor(pageId: string): Editor | null {
  const s = useBoxSelection.getState();
  return s.pageId === pageId && s.editor && !s.editor.isDestroyed ? s.editor : getActiveEditor();
}

/** Live: is there a selection to print on `pageId` (picked boxes, or selected text)? */
export function usePrintSelection(pageId: string | undefined): 'boxes' | 'lines' | 'text' | null {
  const picked = useBoxSelection((s) => (pageId && s.pageId === pageId ? s.ids.length : 0));
  const lines = useLinePicks((s) => (pageId && s.pageId === pageId ? Object.keys(s.byBox).length : 0));
  const boxEditor = useBoxSelection((s) => (pageId && s.pageId === pageId ? s.editor : null));
  const active = useActiveEditor();
  const editor = boxEditor && !boxEditor.isDestroyed ? boxEditor : active;
  const text = useEditorState({ editor, selector: (c) => !!c.editor && !c.editor.isDestroyed && !c.editor.state.selection.empty }) ?? false;
  return picked ? 'boxes' : lines ? 'lines' : text ? 'text' : null;
}
