// Page-level undo (OneNote-style): Ctrl+Z / Ctrl+Y and the ribbon's Undo / Redo take back the
// most recent change on the page, whichever undo manager holds it: the canvas's box geometry
// (create, move, resize, delete) or the text of any box. Each Y.UndoManager keeps its own
// stack; every stack item is stamped with a page-wide sequence number when it is added (or
// grows), and undo / redo pick the manager whose top item is newest. A new change anywhere
// clears every manager's redo stack, as a single history would. Only this client's changes
// are tracked (each manager tracks local origins only).
//
// A box's text history belongs to the page, not to the box's editor (textUndo): it outlives the
// editor, so a box deleted and brought back by undo / redo, or one whose editor isn't mounted,
// still has its typing to undo and redo. The box's editor uses that manager as its own (y-tiptap's
// undo plugin), so the caret still comes back where the change was.
import * as Y from 'yjs';
import type { Editor } from '@tiptap/core';
import { defaultDeleteFilter, defaultProtectedNodes, ySyncPluginKey, yUndoPluginKey } from '@tiptap/y-tiptap';

/** One undo history on the page. `undo` / `redo` default to the manager's own. */
export interface UndoSource {
  manager: () => Y.UndoManager | null | undefined;
  undo?: () => void;
  redo?: () => void;
  /** False while its changes can't be seen (a box someone else deleted): passed over. */
  live?: () => boolean;
}

/** Listeners PageUndo adds to a manager; an editor letting go of a text history leaves them. */
const OWN = new WeakSet<object>();
type Observers = Map<string, Set<object>>;

const SEQ = 'pageUndo.seq';
let counter = 0;
type StackItem = Y.UndoManager['undoStack'][number];
const seqOf = (item: StackItem | undefined) => (item ? ((item.meta.get(SEQ) as number | undefined) ?? 0) : -1);

export class PageUndo {
  private sources: UndoSource[] = [];
  private hooked = new Map<Y.UndoManager, () => void>();
  private listeners = new Set<() => void>();
  private version = 0;
  private texts = new Map<string, Y.UndoManager>();

  /**
   * The text history of one fragment (a box's `box:<id>`), made on first use and kept until the
   * page closes. Its box's editor passes it to y-tiptap's undo plugin (Collaboration's
   * `yUndoOptions.undoManager`), configured as y-tiptap would its own: this client's typing only.
   * `live`: whether the box is on the page (see UndoSource.live).
   */
  textUndo(doc: Y.Doc, field: string, live?: () => boolean): Y.UndoManager {
    const had = this.texts.get(field);
    if (had) return had;
    const um = new Y.UndoManager(doc.getXmlFragment(field), {
      trackedOrigins: new Set<unknown>([ySyncPluginKey]),
      deleteFilter: (item) => defaultDeleteFilter(item, defaultProtectedNodes),
      captureTransaction: (tr) => tr.meta.get('addToHistory') !== false,
    });
    // y-tiptap destroys the manager when the editor goes. This one stays with the page (the doc's
    // destroy still ends it): the editor only takes back the listener its undo plugin added.
    um.destroy = () => {
      const set = (um as unknown as { _observers: Observers })._observers.get('stack-item-added');
      set?.forEach((f) => {
        if (!OWN.has(f)) set.delete(f);
      });
    };
    this.texts.set(field, um);
    this.add({ manager: () => um, live });
    return um;
  }

  /** Forget a fragment's text history (its box was removed for good). */
  forgetText(field: string) {
    const um = this.texts.get(field);
    if (um?.undoStack.length || um?.redoStack.length) um.clear();
  }

  /** The page closed: let go of every history. */
  dispose() {
    for (const off of this.hooked.values()) off();
    this.hooked.clear();
    for (const um of this.texts.values()) Y.UndoManager.prototype.destroy.call(um);
    this.texts.clear();
    this.sources = [];
    this.changed();
  }

  /** Add a history to the page; returns its removal. */
  add(source: UndoSource): () => void {
    this.sources.push(source);
    this.hookAll();
    this.changed();
    return () => {
      this.sources = this.sources.filter((s) => s !== source);
      this.hookAll();
      this.changed();
    };
  }

  canUndo = () => !!this.pick('undo');
  canRedo = () => !!this.pick('redo');

  /** Undo the page's most recent change. False when there is nothing to undo. */
  undo = () => this.run('undo');
  redo = () => this.run('redo');

  /** For useSyncExternalStore: re-render when any stack changes. */
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = () => this.version;

  /** Tell subscribers a stack changed behind the managers' backs (e.g. an item spliced out). */
  changed = () => {
    this.version++;
    for (const fn of [...this.listeners]) fn();
  };

  private run(kind: 'undo' | 'redo'): boolean {
    const picked = this.pick(kind);
    if (!picked) return false;
    const [source, um] = picked;
    const own = kind === 'undo' ? source.undo : source.redo;
    if (own) own();
    else if (kind === 'undo') um.undo();
    else um.redo();
    return true;
  }

  /** The history whose newest undo (or redo) item is the most recent one on the page. */
  private pick(kind: 'undo' | 'redo'): [UndoSource, Y.UndoManager] | null {
    this.hookAll();
    let best: [UndoSource, Y.UndoManager] | null = null;
    let bestSeq = -1;
    for (const s of this.sources) {
      const um = s.manager();
      if (!um || (s.live && !s.live())) continue;
      const seq = seqOf((kind === 'undo' ? um.undoStack : um.redoStack).at(-1));
      if (seq > bestSeq) {
        best = [s, um];
        bestSeq = seq;
      }
    }
    return best;
  }

  /** Listen to every current manager (and stop listening to ones no longer on the page). */
  private hookAll() {
    const live = new Set<Y.UndoManager>();
    for (const s of this.sources) {
      const um = s.manager();
      if (um) live.add(um);
    }
    for (const [um, off] of this.hooked) {
      if (!live.has(um)) {
        off();
        this.hooked.delete(um);
      }
    }
    for (const um of live) if (!this.hooked.has(um)) this.hooked.set(um, this.hook(um));
  }

  private hook(um: Y.UndoManager) {
    const stamp = ({ stackItem, type }: { stackItem: StackItem; type: 'undo' | 'redo' }) => {
      stackItem.meta.set(SEQ, ++counter);
      // A new change (not an undo or redo): nothing on the page can be redone any more.
      if (type === 'undo' && !um.redoing) for (const other of this.hooked.keys()) if (other !== um && other.redoStack.length) other.clear(false, true);
      this.changed();
    };
    const changed = () => this.changed();
    OWN.add(stamp);
    um.on('stack-item-added', stamp);
    um.on('stack-item-updated', stamp);
    um.on('stack-item-popped', changed);
    um.on('stack-cleared', changed);
    return () => {
      um.off('stack-item-added', stamp);
      um.off('stack-item-updated', stamp);
      um.off('stack-item-popped', changed);
      um.off('stack-cleared', changed);
    };
  }
}

const byDoc = new WeakMap<Y.Doc, PageUndo>();

/** The page undo of a canvas page's Y.Doc (made on first use). */
export function pageUndoFor(doc: Y.Doc): PageUndo {
  let p = byDoc.get(doc);
  if (!p) {
    const page = (p = new PageUndo());
    byDoc.set(doc, page);
    doc.on('destroy', () => page.dispose());
  }
  return p;
}

/** The page undo an editor belongs to, if its page has one. */
export function pageUndoOf(editor: Editor | null | undefined): PageUndo | null {
  if (!editor || editor.isDestroyed) return null;
  const doc = (ySyncPluginKey.getState(editor.state) as { doc?: Y.Doc } | undefined)?.doc;
  return (doc && byDoc.get(doc)) ?? null;
}

/**
 * End the text undo step an editor is building, so the next change is a step of its own. Yjs folds
 * every change made within half a second of the last into one step, which is right for typing but
 * wrong for a deliberate action (applying a link, say) that follows it quickly: Ctrl+Z would take
 * both back, which can empty a box that was only just typed.
 */
export function closeUndoGroup(editor: Editor | null | undefined) {
  if (!editor || editor.isDestroyed) return;
  (yUndoPluginKey.getState(editor.state) as { undoManager?: Y.UndoManager } | undefined)?.undoManager?.stopCapturing();
}
