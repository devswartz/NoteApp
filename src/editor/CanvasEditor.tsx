// Canvas pages (docs/PLAN_CANVAS.md, phase 2): text boxes placed anywhere on the page.
// Each box is a full editor bound to its own `box:<id>` fragment of the page's Y.Doc;
// the geometry lives in the `boxes` map (shared/pageDoc.ts). All boxes share the page's
// collab session, so presence and carets work as on document pages, and moves made by
// others show live.
//
// A blank page offers its first box at the top left, ready for typing (OneNote: just start
// typing); it is only stored once something is typed in it, so a page you merely open stays
// empty. That box, and the one a document became, is "wide": drawn across the page's full
// width (OneNote-style), following window and panel resizes, until resized by hand.
//
// Mouse: click empty space to start a box; drag a box's top edge to move it and its right
// edge to set its width; an empty box goes away when you leave it.
// Keyboard: Escape leaves a box (selects it), Enter edits it again, Tab / Shift+Tab move
// between boxes in reading order, arrows nudge a selected box (Shift: 1 px), Delete removes it.
// Undo: Ctrl+Z outside a box undoes creating, moving, resizing and deleting boxes (yours only);
// inside a box it undoes text as usual.
// Phones (≤760px) get the boxes stacked in reading order, edited normally (no placing); a page
// with one box is just one full-width editor.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { EditorContent, type Editor } from '@tiptap/react';
import { Extension, type JSONContent } from '@tiptap/core';
import type { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { Plus } from 'lucide-react';
import { BOXES_KEY, FIRST_BOX, FIRST_BOX_ID, READABLE_BOX_W, boxField, boxGeoms, fragmentIsEmpty, newBoxMap, readingOrder, type BoxGeom } from '../../shared/pageDoc.ts';
import { useCollab, usePresenceRole, type CollabSession, type PresenceUser, type SaveState, type SyncStatus } from './collab.ts';
import { EditorChrome, EditorMenus, usePageEditor, useSlashFilePickers } from './NoteEditor.tsx';
import { clearActiveEditor, setActiveEditor } from './activeEditor.ts';
import { useCommentBinding } from './collabComments.ts';
import { insertTaskAtEnd } from './TaskRef.tsx';
import { adjacentBox, boxAtClick, boxBelow, clampPos, clampWidth, frontZ, newBoxId, nudge, surfaceSize, UNMEASURED_H, wideWidth } from './canvasGeom.ts';
import { toast } from '../store.ts';
import { GEOM_ORIGIN, pageSchema, writeBoxes, type CanvasHandle } from './canvasDoc.ts';
import { headingsOf } from './Outline.tsx';
import { useIsMobile } from '../components/ui.tsx';
import type { User } from '../../shared/types.ts';
import '../styles/canvas.css';

interface Props {
  pageId: string;
  workspaceId: string;
  user: User;
  canEdit: boolean;
  onStatus: (s: SyncStatus) => void;
  onPresence: (users: PresenceUser[]) => void;
  onSave?: (s: SaveState) => void;
  onServerSynced?: () => void;
  /** The box editor the page chrome acts on: the last focused one (or the first to mount). */
  onReady: (editor: Editor) => void;
  onAwareness?: (awareness: Awareness | null) => void;
  /** Mount every box at once (e.g. to scroll to a task deep link). */
  mountAll?: boolean;
  /** Whole-canvas actions for the page chrome (templates, import, version history, outline). */
  onCanvas?: (h: CanvasHandle | null) => void;
  /** Put the caret in a blank page's first box when it opens (unless something else has focus). */
  autoFocus?: boolean;
}

type Pending = { id: string; then: 'focus' | 'task' | { heading: number } };

/** Storing a blank page's first box once something is typed in it: not an undo step. */
const READY_ORIGIN = { canvas: 'first-box' };

/** Removing an empty box you just left: not an undo step (and its creation stops being one). */
const DROP_ORIGIN = { canvas: 'drop-empty' };
/** Bringing a focused box to the front: not an undo step. */
const FOCUS_ORIGIN = { canvas: 'focus' };
/** Focus moved here keeps the box "in use" (toolbar menus, link editor, dialogs…). */
const KEEPS_BOX = '.ribbon,.popover, .bubble-menu, .table-bar, .slash-menu, .link-editor, [role="menu"], [role="dialog"], [role="listbox"]';

/**
 * Escape in a box leaves the text and selects the box. Lowest priority, so open menus
 * (slash, mentions, [[links]]) close first. (ProseMirror swallows Escape, so it can't be
 * handled on the way up like Tab.)
 */
const LeaveBoxOnEscape = Extension.create({
  name: 'leaveBoxOnEscape',
  priority: 0,
  addKeyboardShortcuts() {
    return {
      Escape: () => {
        const box = this.editor.view.dom.closest<HTMLElement>('.canvas-box');
        if (!box) return false;
        // A suggestion menu (slash, [[link]], @mention) is open: Escape is for closing it.
        if (document.querySelector('.slash-menu, .mention-pop:not(.mention-pop-inline)')) return false;
        box.focus({ preventScroll: true });
        return true;
      },
    };
  },
});
const BOX_EXTENSIONS = [LeaveBoxOnEscape];

/** Live geometry of every box. */
function useBoxes(doc: Y.Doc): BoxGeom[] {
  const map = useMemo(() => doc.getMap<unknown>(BOXES_KEY), [doc]);
  const [boxes, setBoxes] = useState<BoxGeom[]>(() => boxGeoms(doc));
  useEffect(() => {
    const update = () => setBoxes(boxGeoms(doc));
    update();
    map.observeDeep(update);
    return () => map.unobserveDeep(update);
  }, [doc, map]);
  return boxes;
}

/** Write fields of one box's geometry (no-op if the box is gone). Undoable unless another origin is given. */
function setGeom(doc: Y.Doc, id: string, fields: Partial<Omit<BoxGeom, 'id'>>, origin: unknown = GEOM_ORIGIN) {
  const m = doc.getMap<unknown>(BOXES_KEY).get(id);
  if (!(m instanceof Y.Map)) return;
  doc.transact(() => {
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) {
        if (m.has(k)) m.delete(k);
      } else if (m.get(k) !== v) m.set(k, v);
    }
  }, origin);
}

/** Scroll an element into view and keep it there for a few frames while lazily rendered sizes settle. */
function settleInto(el: () => Element | null | undefined, block: ScrollLogicalPosition) {
  let frames = 0;
  const step = () => {
    const e = el();
    if (e instanceof HTMLElement) e.scrollIntoView({ block });
    if (++frames < 4) requestAnimationFrame(step);
  };
  step();
}

/** Put the caret in the `index`-th heading of a box's editor and scroll to it. */
function revealHeadingIn(editor: Editor, index: number) {
  const h = headingsOf(editor)[index];
  if (!h) return;
  editor.chain().setTextSelection(h.pos + 1).focus(undefined, { scrollIntoView: false }).run();
  settleInto(() => editor.view.nodeDOM(h.pos) as Element | null, 'start');
}

const CAPTURE_MS = 500;

/**
 * Undo for box geometry: one Y.UndoManager over the boxes map (and each box's content, so
 * undoing a delete brings the text back), tracking only this client's GEOM_ORIGIN changes.
 * Text typed in a box has its own undo inside the box.
 */
function useGeometryUndo(doc: Y.Doc) {
  const um = useMemo(() => new Y.UndoManager(doc.getMap<unknown>(BOXES_KEY), { trackedOrigins: new Set([GEOM_ORIGIN]), captureTimeout: CAPTURE_MS }), [doc]);
  useEffect(() => {
    const map = doc.getMap<unknown>(BOXES_KEY);
    const scope = () => map.forEach((_v, id) => um.addToScope(doc.getXmlFragment(boxField(id))));
    scope();
    map.observe(scope);
    // The manager goes with the doc (it listens for the doc's destroy); not here, so a remounted effect keeps it.
    return () => map.unobserve(scope);
  }, [doc, um]);
  return um;
}

export function CanvasEditor({ pageId, workspaceId, user, canEdit, onStatus, onPresence, onSave, onServerSynced, onReady, onAwareness, mountAll, onCanvas, autoFocus = false }: Props) {
  const session = useCollab(pageId, user, { onStatus, onPresence, onSave });
  const { doc } = session;
  useEffect(() => {
    onAwareness?.(session.provider.awareness);
    return () => onAwareness?.(null);
  }, [session, onAwareness]);
  usePresenceRole(session, user, canEdit);
  useSlashFilePickers(pageId, workspaceId);
  useEffect(() => {
    if (session.serverSynced) onServerSynced?.();
  }, [session.serverSynced]); // eslint-disable-line react-hooks/exhaustive-deps

  const isMobile = useIsMobile();
  const boxes = useBoxes(doc);
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [mounted, setMounted] = useState<Set<string>>(() => new Set());
  const [active, setActive] = useState<Editor | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  // Focus is in the active box's own floating toolbar, which lives outside the box (in the page
  // scroller): the box keeps looking like the one being edited (opaque) meanwhile.
  const [menuFocus, setMenuFocus] = useState(false);
  useEffect(() => {
    const on = (e: FocusEvent) => setMenuFocus(!!(e.target as HTMLElement | null)?.closest?.('.bubble-menu'));
    document.addEventListener('focusin', on);
    return () => document.removeEventListener('focusin', on);
  }, []);
  const editors = useRef(new Map<string, Editor>());
  const elements = useRef(new Map<string, HTMLElement>());
  const pending = useRef<Pending | null>(null);
  const reported = useRef(false);
  const boxesRef = useRef(boxes);
  boxesRef.current = boxes;
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const undo = useGeometryUndo(doc);
  const heightsRef = useRef(heights);
  heightsRef.current = heights;

  useCommentBinding(active);
  // The ribbon acts on the last-focused box (none until one is focused).
  useEffect(() => {
    if (!active || active.isDestroyed || !canEdit) return;
    setActiveEditor(active);
    return () => clearActiveEditor(active);
  }, [active, canEdit]);

  const mount = useCallback((id: string) => setMounted((s) => (s.has(id) ? s : new Set(s).add(id))), []);

  // Lazy editors: a box gets its editor once it comes near the viewport, then keeps it.
  const observer = useMemo(
    () =>
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver(
            (entries) => {
              for (const e of entries) {
                const id = (e.target as HTMLElement).dataset.boxId;
                if (e.isIntersecting && id) mount(id);
              }
            },
            { rootMargin: '600px' },
          ),
    [mount],
  );
  useEffect(() => () => observer?.disconnect(), [observer]);
  useEffect(() => {
    if (mountAll || !observer) setMounted(new Set(boxes.map((b) => b.id)));
  }, [mountAll, observer, boxes]);

  const registerEl = useCallback(
    (id: string, el: HTMLElement | null) => {
      const prev = elements.current.get(id);
      if (prev && prev !== el) observer?.unobserve(prev);
      if (el) {
        elements.current.set(id, el);
        observer?.observe(el);
      } else elements.current.delete(id);
    },
    [observer],
  );

  // The surface is at least as big as the space it sits in.
  useEffect(() => {
    const el = surfaceRef.current?.parentElement;
    if (!el || typeof ResizeObserver === 'undefined') return;
    // The surface's visible width: the viewport's content box.
    const ro = new ResizeObserver(() => {
      const cs = getComputedStyle(el);
      const w = el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
      setViewport({ w, h: Math.max(320, window.innerHeight - el.getBoundingClientRect().top - 40) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [isMobile]);

  const onHeight = useCallback((id: string, h: number) => setHeights((s) => (s[id] === h ? s : { ...s, [id]: h })), []);

  // A blank page: its first box, offered for typing but not stored until something is typed.
  // (Shown read-only to viewers too, so a blank page looks the same to everyone.)
  const ready = session.synced && boxes.length === 0;
  const readyFocused = useRef(false);
  const autoFocusRef = useRef(autoFocus && !isMobile);
  useEffect(() => {
    if (!ready || !canEdit) return;
    mount(FIRST_BOX_ID); // keeps its editor when it becomes a stored box
    const frag = doc.getXmlFragment(boxField(FIRST_BOX_ID));
    const onTr = (tr: Y.Transaction) => {
      if (!tr.local || !tr.changedParentTypes.has(frag as unknown as Y.AbstractType<Y.YEvent<Y.AbstractType<unknown>>>)) return;
      // After this transaction: store the box once it holds something (not for a stray empty line).
      queueMicrotask(() => {
        const map = doc.getMap<unknown>(BOXES_KEY);
        if (map.size || fragmentIsEmpty(frag)) return;
        doc.transact(() => map.set(FIRST_BOX_ID, newBoxMap(FIRST_BOX)), READY_ORIGIN);
      });
    };
    doc.on('afterTransaction', onTr);
    return () => doc.off('afterTransaction', onTr);
  }, [ready, canEdit, doc, mount]);

  const runPending = (id: string, editor: Editor) => {
    const p = pending.current;
    if (!p || p.id !== id) return;
    pending.current = null;
    // The view is attached to the DOM after this render; act on the next tick.
    setTimeout(() => {
      if (editor.isDestroyed) return;
      if (p.then === 'task') insertTaskAtEnd(editor, pageId);
      else if (p.then === 'focus') editor.commands.focus('end');
      else revealHeadingIn(editor, p.then.heading);
    }, 0);
  };

  const onEditor = useCallback(
    (id: string, editor: Editor | null) => {
      if (!editor) {
        const gone = editors.current.get(id);
        editors.current.delete(id);
        setActive((a) => (a === gone ? null : a));
        setActiveId((a) => (a === id ? null : a));
        return;
      }
      editors.current.set(id, editor);
      // Until a box is focused, the ribbon acts on the page's first box (so it is live as soon
      // as the page opens, and while the caret is in the title).
      if (id === (readingOrder(boxesRef.current)[0]?.id ?? FIRST_BOX_ID)) setActive((a) => a ?? editor);
      if (!reported.current) {
        reported.current = true;
        onReady(editor);
      }
      runPending(id, editor);
      // A blank page you open: the caret waits in its first box, unless you're already somewhere (the title).
      if (id === FIRST_BOX_ID && autoFocusRef.current && !readyFocused.current) {
        readyFocused.current = true;
        setTimeout(() => {
          const a = document.activeElement;
          if (!editor.isDestroyed && editor.isEmpty && (!a || a === document.body)) editor.commands.focus('start');
        }, 0);
      }
    },
    [onReady], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const createBox = (g: Omit<BoxGeom, 'id'>, then: Pending['then']) => {
    const id = newBoxId();
    undo.stopCapturing(); // its own undo step
    doc.transact(() => doc.getMap<unknown>(BOXES_KEY).set(id, newBoxMap(g)), GEOM_ORIGIN);
    undo.undoStack.at(-1)?.meta.set('created', id);
    undo.stopCapturing();
    pending.current = { id, then };
    mount(id);
    return id;
  };

  // The page chrome's whole-canvas actions (templates, Markdown import, version history).
  useEffect(() => {
    if (!onCanvas) return;
    onCanvas({
      pageId,
      doc,
      addBox: (blocks: JSONContent[]) => {
        // The first box of a page is its main, wide box.
        const g = boxesRef.current.length ? boxBelow(boxesRef.current, heightsRef.current) : { ...FIRST_BOX, z: 0 };
        undo.stopCapturing();
        const [id] = writeBoxes(doc, pageSchema(pageId), [{ ...g, content: blocks }]);
        undo.stopCapturing();
        mount(id!);
        return id!;
      },
      revealHeading: (id: string, index: number) => {
        elements.current.get(id)?.scrollIntoView({ block: 'start' });
        const ed = editors.current.get(id);
        if (ed && !ed.isDestroyed) revealHeadingIn(ed, index);
        else {
          pending.current = { id, then: { heading: index } };
          mount(id);
        }
      },
      boxElement: (id: string) => elements.current.get(id) ?? null,
    });
    return () => onCanvas(null);
  }, [doc, pageId, onCanvas, undo, mount]);

  // Ctrl+Z / Ctrl+Shift+Z (Ctrl+Y) outside a box: undo / redo box changes.
  useEffect(() => {
    if (!canEdit) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      const redo = (k === 'z' && e.shiftKey) || (k === 'y' && !e.shiftKey);
      if (k !== 'z' && !redo) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('.ProseMirror, input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      e.preventDefault();
      if (redo) undo.redo();
      else undo.undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canEdit, undo]);

  /**
   * Remove a box and its content. `undoable`: an undo step (Ctrl+Z), and a toast offers to
   * bring it back. Otherwise (an empty box you left) its creation stops being an undo step too.
   */
  const removeBox = useCallback(
    (id: string, undoable: boolean) => {
      const map = doc.getMap<unknown>(BOXES_KEY);
      if (!map.has(id)) return;
      const frag = doc.getXmlFragment(boxField(id));
      if (undoable) undo.stopCapturing();
      doc.transact(
        () => {
          map.delete(id);
          if (frag.length) frag.delete(0, frag.length);
        },
        undoable ? GEOM_ORIGIN : DROP_ORIGIN,
      );
      if (!undoable) {
        const i = undo.undoStack.findIndex((s) => s.meta.get('created') === id);
        if (i >= 0) undo.undoStack.splice(i, 1);
        return;
      }
      const item = undo.undoStack.at(-1);
      undo.stopCapturing();
      toast('Text box deleted', {
        action: {
          label: 'Undo',
          // Only while the delete is still the latest step (otherwise Ctrl+Z walks back to it).
          run: () => undo.undoStack.at(-1) === item && undo.undo(),
        },
      });
    },
    [doc, undo],
  );

  /** Remove `id` if it holds nothing (an empty box disappears when you leave it). */
  const dropIfEmpty = useCallback(
    (id: string) => {
      const ed = editors.current.get(id);
      if (!canEdit || !ed || ed.isDestroyed || !ed.isEmpty) return;
      removeBox(id, false);
    },
    [canEdit, removeBox],
  );

  const focusBox = (id: string, where: 'start' | 'end') => {
    elements.current.get(id)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const ed = editors.current.get(id);
    if (ed && !ed.isDestroyed) ed.commands.focus(where);
    else {
      pending.current = { id, then: 'focus' };
      mount(id);
    }
  };
  const selectBox = (id: string) => {
    const el = elements.current.get(id);
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };

  const onBoxFocus = (id: string) => {
    if (activeId && activeId !== id) dropIfEmpty(activeId);
    setActiveId(id);
    const ed = editors.current.get(id);
    if (ed && ed !== active) {
      setActive(ed);
      onReady(ed);
    }
    if (canEdit && !isMobile) {
      const z = frontZ(boxesRef.current, id);
      if (z !== null) setGeom(doc, id, { z }, FOCUS_ORIGIN);
    }
  };

  const onBoxBlur = (id: string, el: HTMLElement) => {
    // After the browser has moved focus: still in this box, or in a menu acting on it?
    setTimeout(() => {
      const now = document.activeElement;
      if (now && (el.contains(now) || now.closest(KEEPS_BOX))) return;
      dropIfEmpty(id);
    }, 0);
  };

  const onBoxKey = (id: string, e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.defaultPrevented || e.nativeEvent.isComposing) return;
    const inEditor = e.target !== e.currentTarget;
    // Keys typed in a field inside the box (a task title, alt text…) belong to that field.
    if (inEditor && !(e.target as HTMLElement).classList.contains('ProseMirror')) return;
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
    if (e.key === 'Tab' && plain) {
      const next = adjacentBox(boxesRef.current, id, e.shiftKey ? -1 : 1);
      if (!next) return; // past the last box: leave the canvas as usual
      e.preventDefault();
      if (inEditor) focusBox(next.id, e.shiftKey ? 'end' : 'start');
      else selectBox(next.id);
      return;
    }
    if (inEditor) return;
    // The box itself is selected.
    if (e.key === 'Enter' && plain) {
      e.preventDefault();
      focusBox(id, 'end');
    } else if (canEdit && (e.key === 'Delete' || e.key === 'Backspace') && plain) {
      e.preventDefault();
      const next = adjacentBox(boxesRef.current, id, 1) ?? adjacentBox(boxesRef.current, id, -1);
      removeBox(id, true);
      if (next) selectBox(next.id);
    } else if (canEdit && !isMobile && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const b = boxesRef.current.find((x) => x.id === id);
      const to = b && nudge(b, e.key, e.shiftKey);
      if (to) {
        e.preventDefault();
        setGeom(doc, id, to);
      }
    }
  };

  /** Drag the top edge (move) or the right edge (width). Writes are batched per frame. */
  const startDrag = (id: string, mode: 'move' | 'width', e: ReactPointerEvent<HTMLElement>) => {
    if (!canEdit || e.button !== 0) return;
    const b = boxesRef.current.find((x) => x.id === id);
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget;
    handle.setPointerCapture?.(e.pointerId);
    // A wide box is resized from the width it is drawn at, and keeps the width you give it.
    const start = { px: e.clientX, py: e.clientY, x: b.x, y: b.y, w: b.wide ? (elements.current.get(id)?.offsetWidth ?? b.w) : b.w };
    // The whole drag is one undo step, however long it takes.
    undo.stopCapturing();
    undo.captureTimeout = Number.MAX_SAFE_INTEGER;
    const z = frontZ(boxesRef.current, id);
    if (z !== null) setGeom(doc, id, { z }, FOCUS_ORIGIN);
    let frame = 0;
    let next: Partial<BoxGeom> | null = null;
    const flush = () => {
      frame = 0;
      if (next) setGeom(doc, id, next);
      next = null;
    };
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - start.px;
      const dy = ev.clientY - start.py;
      next = mode === 'move' ? clampPos(start.x + dx, start.y + dy) : { w: clampWidth(start.w + dx), wide: undefined };
      if (!frame) frame = requestAnimationFrame(flush);
    };
    const up = () => {
      if (frame) cancelAnimationFrame(frame);
      flush();
      undo.captureTimeout = CAPTURE_MS;
      undo.stopCapturing();
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      document.body.classList.remove('canvas-dragging');
      // Keep editing if you were; otherwise the moved box is selected.
      if (!editors.current.get(id)?.isFocused) selectBox(id);
    };
    document.body.classList.add('canvas-dragging');
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  };

  /** A click on a box's padding puts the caret in its text (at the end; a blank page's first box is empty anyway). */
  const onPadDown = (id: string) => {
    if (editors.current.get(id)?.isEditable) focusBox(id, 'end');
  };

  /** Click on empty space: a new box there. */
  const onSurfaceDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!canEdit || isMobile || e.button !== 0 || e.target !== e.currentTarget) return;
    e.preventDefault(); // keep focus where it is until the new box takes it
    const r = e.currentTarget.getBoundingClientRect();
    createBox(boxAtClick(boxesRef.current, e.clientX - r.left, e.clientY - r.top), 'focus');
  };

  /** Where a box added "below the others" goes; on a blank page that's its main, wide box. */
  const below = () => (boxesRef.current.length ? boxBelow(boxesRef.current, heights) : { ...FIRST_BOX, z: 1 });
  /** "Add a task to this page": in the box you were last in (a blank page's ready box), or a new box under the others. */
  const addTask = () => {
    const id = activeId && editors.current.has(activeId) ? activeId : ready && editors.current.has(FIRST_BOX_ID) ? FIRST_BOX_ID : null;
    if (id) insertTaskAtEnd(editors.current.get(id)!, pageId);
    else createBox(below(), 'task');
  };
  const addBoxBelow = () => createBox(below(), 'focus');

  // Wide boxes as drawn: the page's full width, right of where they start.
  const drawn = useMemo(
    () => (ready ? [FIRST_BOX] : boxes).map((b) => (b.wide ? { ...b, w: wideWidth(b.x, viewport.w, READABLE_BOX_W) } : b)),
    [ready, boxes, viewport.w],
  );
  const size = surfaceSize(drawn, heights, viewport.w, viewport.h);
  const stacked = isMobile;
  const list = stacked ? readingOrder(drawn) : drawn;
  const single = stacked && list.length === 1;

  return (
    <div className={`editor-wrap canvas-wrap ${session.synced ? '' : 'is-loading'} ${stacked ? 'is-stacked' : ''} ${single ? 'is-single' : ''}`}>
      <div className="canvas-viewport">
        <div
          ref={surfaceRef}
          className={`canvas-surface ${canEdit ? 'can-edit' : ''}`}
          style={stacked ? undefined : { width: size.w, height: size.h }}
          onMouseDown={onSurfaceDown}
          data-testid="canvas-surface"
        >
          {list.map((b) => (
            <CanvasBox
              key={b.id}
              box={b}
              session={session}
              pageId={pageId}
              workspaceId={workspaceId}
              user={user}
              canEdit={canEdit}
              stacked={stacked}
              mounted={mounted.has(b.id) || ready}
              ready={ready}
              isActive={activeId === b.id}
              holding={activeId === b.id && menuFocus}
              height={heights[b.id]}
              registerEl={registerEl}
              onEditor={onEditor}
              onHeight={onHeight}
              onFocusBox={onBoxFocus}
              onBlurBox={onBoxBlur}
              onKeyBox={onBoxKey}
              onDrag={startDrag}
              onPadDown={onPadDown}
            />
          ))}
        </div>
      </div>
      {canEdit && stacked && (
        <button className="add-task-end canvas-add-box" onClick={addBoxBelow}>
          <Plus size={15} /> Add a text box
        </button>
      )}
      {canEdit && (
        <button className="add-task-end" onClick={addTask}>
          <Plus size={15} /> Add a task to this page
        </button>
      )}
      <EditorMenus />
    </div>
  );
}

interface BoxProps {
  box: BoxGeom;
  session: CollabSession;
  pageId: string;
  workspaceId: string;
  user: User;
  canEdit: boolean;
  stacked: boolean;
  mounted: boolean;
  /** A blank page's first box, not stored yet. */
  ready: boolean;
  isActive: boolean;
  /** Focus is in this box's floating toolbar. */
  holding: boolean;
  height: number | undefined;
  registerEl: (id: string, el: HTMLElement | null) => void;
  onEditor: (id: string, editor: Editor | null) => void;
  onHeight: (id: string, h: number) => void;
  onFocusBox: (id: string) => void;
  onBlurBox: (id: string, el: HTMLElement) => void;
  onKeyBox: (id: string, e: ReactKeyboardEvent<HTMLElement>) => void;
  onDrag: (id: string, mode: 'move' | 'width', e: ReactPointerEvent<HTMLElement>) => void;
  /** A click on the box's own padding (not its text, not a handle). */
  onPadDown: (id: string) => void;
}

function CanvasBox({ box, session, pageId, workspaceId, user, canEdit, stacked, mounted, ready, isActive, holding, height, registerEl, onEditor, onHeight, onFocusBox, onBlurBox, onKeyBox, onDrag, onPadDown }: BoxProps) {
  const { id } = box;
  const ref = useRef<HTMLDivElement | null>(null);
  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      ref.current = el;
      registerEl(id, el);
    },
    [id, registerEl],
  );
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => onHeight(id, Math.round(el.offsetHeight)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [id, onHeight]);
  const place = !stacked;
  return (
    <div
      ref={setRef}
      className={`canvas-box ${isActive ? 'is-active' : ''} ${box.wide ? 'is-wide' : ''} ${ready ? 'is-ready' : ''} ${holding ? 'is-holding' : ''}`}
      data-box-id={id}
      style={place ? { left: box.x, top: box.y, width: box.w, zIndex: box.z } : undefined}
      tabIndex={-1}
      role="group"
      aria-label="Text box"
      onFocus={() => onFocusBox(id)}
      onBlur={(e) => onBlurBox(id, e.currentTarget)}
      onKeyDown={(e) => onKeyBox(id, e)}
      onMouseDown={(e) => {
        if (e.button !== 0 || e.target !== e.currentTarget) return;
        e.preventDefault();
        onPadDown(id);
      }}
    >
      {canEdit && place && <div className="canvas-box-move" title="Drag to move" aria-hidden onPointerDown={(e) => onDrag(id, 'move', e)} />}
      {mounted ? (
        <BoxEditor id={id} wide={!!box.wide} session={session} pageId={pageId} workspaceId={workspaceId} user={user} canEdit={canEdit} isActive={isActive} onEditor={onEditor} />
      ) : (
        <div className="canvas-box-placeholder" style={{ height: height ?? UNMEASURED_H }} />
      )}
      {canEdit && place && <div className="canvas-box-width" title="Drag to set the width" aria-hidden onPointerDown={(e) => onDrag(id, 'width', e)} />}
    </div>
  );
}

function BoxEditor({ id, wide, session, pageId, workspaceId, user, canEdit, isActive, onEditor }: Pick<BoxProps, 'session' | 'pageId' | 'workspaceId' | 'user' | 'canEdit' | 'isActive' | 'onEditor'> & { id: string; wide: boolean }) {
  // The main (wide) box holds what used to be a whole document: render-skipping for long ones, and the block handle.
  const editor = usePageEditor(session, { pageId, workspaceId, user, canEdit, field: boxField(id), long: wide, label: 'Text box content', extensions: BOX_EXTENSIONS });
  useEffect(() => {
    if (!editor) return;
    onEditor(id, editor);
    return () => onEditor(id, null);
  }, [editor, id, onEditor]);
  return (
    <>
      {editor && canEdit && isActive && <EditorChrome editor={editor} handle={wide} />}
      <EditorContent editor={editor} className="canvas-box-content" />
    </>
  );
}
