// taskRef bookkeeping on ProseMirror documents (pure, unit-tested).
import type { Node as PMNode } from '@tiptap/pm/model';

export function taskRefIds(doc: PMNode): Set<string> {
  const ids = new Set<string>();
  doc.descendants((node) => {
    if (node.type.name === 'taskRef' && node.attrs.taskId) ids.add(node.attrs.taskId as string);
    return !node.isTextblock;
  });
  return ids;
}

/** Which tasks an undo/redo transaction removed and re-added. Pure, for tests. */
export function undoRedoChanges(before: PMNode, after: PMNode) {
  const a = taskRefIds(before);
  const b = taskRefIds(after);
  return { removed: [...a].filter((id) => !b.has(id)), added: [...b].filter((id) => !a.has(id)) };
}

/**
 * Decides what undo/redo does to tasks created in this session (see undoTasks.ts).
 *
 * A task is *eligible* while its taskRef has only ever been added or removed by its own
 * convert (and undo/redo of that convert). Once an ordinary edit removes the taskRef
 * (deleting the line, cutting it, a collaborator's change), the task is no longer
 * eligible: from then on removals follow the normal rule, so the task becomes
 * standalone, even if a later redo re-removes the taskRef.
 */
export class UndoTaskTracker {
  private eligible = new Set<string>();
  /** Deleted by an undo; a redo that brings the taskRef back recreates it. */
  private deleted = new Set<string>();

  created(id: string) {
    this.eligible.add(id);
  }

  hasEligible() {
    return this.eligible.size > 0;
  }

  /** An ordinary (non undo/redo) edit removed these taskRefs. */
  editRemoved(ids: Iterable<string>) {
    for (const id of ids) this.eligible.delete(id);
  }

  /** An undo/redo transaction removed and added these taskRefs. */
  undoRedo(removed: string[], added: string[]): { remove: string[]; recreate: string[] } {
    const remove = removed.filter((id) => this.eligible.has(id) && !this.deleted.has(id));
    const recreate = added.filter((id) => this.deleted.has(id));
    remove.forEach((id) => this.deleted.add(id));
    recreate.forEach((id) => this.deleted.delete(id));
    return { remove, recreate };
  }
}

/** taskRef ids that a transaction's steps deleted (scans only the deleted ranges, so it's cheap per keystroke). */
export function taskRefsDeletedBy(tr: { steps: { getMap(): { forEach(f: (oldStart: number, oldEnd: number) => void): void } }[]; docs: PMNode[] }): Set<string> {
  const out = new Set<string>();
  tr.steps.forEach((step, i) => {
    const doc = tr.docs[i];
    step.getMap().forEach((oldStart, oldEnd) => {
      if (oldEnd <= oldStart) return;
      doc.nodesBetween(oldStart, Math.min(oldEnd, doc.content.size), (node) => {
        if (node.type.name === 'taskRef' && node.attrs.taskId) out.add(node.attrs.taskId as string);
        return !node.isTextblock;
      });
    });
  });
  return out;
}
