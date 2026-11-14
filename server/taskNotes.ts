// The notes under a task in a page (src/editor/taskChildren.ts): a taskRef element's children.
//   - which task each nested task sits under (the room sets subtask parents from it on save, collab.ts)
//   - the notes as Markdown, read-only for the task panel ("From the note", GET /tasks/:id/notes)
//   - unwrapping a task element whose task can't be kept (a page copy, a template), so its notes stay
// Owner: Tasks & Dashboard.
import * as Y from 'yjs';
import { pageFragments } from '../shared/pageDoc.ts';
import { block, type TaskLookup } from './markdown.ts';

/** Where a task sits in a page: under which task (the outermost task block around it: subtasks are one level deep), or none. */
export interface TaskPlace {
  id: string;
  parent: string | null;
  /** How many task blocks it is nested in (0 at the top). */
  depth: number;
  /** Ticked / all items of the plain checklists in its own notes (not in its subtasks' notes). */
  checklist: { done: number; total: number };
}

/** Checklist items (taskItem) under an element, not looking inside nested task blocks. */
function countChecklist(node: Y.XmlElement, acc = { done: 0, total: 0 }) {
  for (const c of node.toArray()) {
    if (!(c instanceof Y.XmlElement) || c.nodeName === 'taskRef') continue;
    if (c.nodeName === 'taskItem') {
      acc.total++;
      const v = c.getAttribute('checked') as unknown;
      if (v === true || v === 'true') acc.done++;
    }
    countChecklist(c, acc);
  }
  return acc;
}

/** Every task block of a page, in reading order, with the task it sits under. A task listed twice keeps its first place. */
export function taskPlaces(doc: Y.Doc): TaskPlace[] {
  const out: TaskPlace[] = [];
  const seen = new Set<string>();
  const walk = (node: Y.XmlFragment | Y.XmlElement, outer: string | null, depth: number) => {
    for (const child of node.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === 'taskRef') {
        const id = child.getAttribute('taskId');
        const ok = typeof id === 'string' && !!id;
        if (ok && !seen.has(id)) {
          seen.add(id);
          out.push({ id, parent: outer, depth, checklist: countChecklist(child) });
        }
        walk(child, outer ?? (ok ? id : null), depth + 1);
      } else walk(child, outer, depth);
    }
  };
  for (const frag of pageFragments(doc)) walk(frag, null, 0);
  return out;
}

/** The task block for `taskId` in a page, or null. */
export function findTaskElement(doc: Y.Doc, taskId: string): Y.XmlElement | null {
  const walk = (node: Y.XmlFragment | Y.XmlElement): Y.XmlElement | null => {
    for (const child of node.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === 'taskRef' && child.getAttribute('taskId') === taskId) return child;
      const hit = walk(child);
      if (hit) return hit;
    }
    return null;
  };
  for (const frag of pageFragments(doc)) {
    const hit = walk(frag);
    if (hit) return hit;
  }
  return null;
}

/** The notes under a task block as Markdown ('' when it has none). */
export function notesMarkdown(el: Y.XmlElement, tasks: TaskLookup): string {
  return (el.toArray() as (Y.XmlElement | Y.XmlText)[])
    .flatMap((c) => block(c, tasks))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Replace a task block with copies of its children (nothing when it has none): the task goes, its notes stay. */
export function unwrapTaskElement(el: Y.XmlElement) {
  const parent = el.parent as Y.XmlElement | Y.XmlFragment | null;
  if (!parent) return;
  const idx = parent.toArray().indexOf(el);
  if (idx < 0) return;
  const kids = (el.toArray() as (Y.XmlElement | Y.XmlText)[]).map((c) => c.clone());
  parent.delete(idx, 1);
  if (kids.length) parent.insert(idx, kids);
}
