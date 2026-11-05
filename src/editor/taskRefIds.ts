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
