// Notes under a task, like the lines indented under a OneNote To Do tag.
//
// A `taskRef` block holds optional block content: its children (bullets, numbered lists, paragraphs and nested task
// blocks, which are the task's subtasks). This module has the pure ProseMirror parts, unit-tested in node
// (tests/taskChildren.test.ts):
//   - Tab on the block right after a task moves it into the task's children; Shift+Tab lifts a child back out
//   - Enter on an empty last child leaves the task (like an empty list item leaves its list)
//   - converting lines to tasks keeps each line's sub-points under its new task (convertTransaction)
//   - unwrapping a task keeps its children on the page (a task deleted from the Tasks views)
// Which task a nested task is a subtask of is worked out by the server from where it sits in the page
// (server/taskNotes.ts), so every way a task can move (Tab, drag, paste, undo, a collaborator) is covered.
import { Fragment, type Node as PMNode, type ResolvedPos } from '@tiptap/pm/model';
import { NodeSelection, Selection, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';

export const TASK = 'taskRef';
const LISTS = new Set(['bulletList', 'orderedList', 'taskList']);
const ITEMS = new Set(['listItem', 'taskItem']);

/** A block that Tab / Shift+Tab act on: where it starts, the node, and its start resolved (its parent is the container). */
export interface ChildBlock {
  pos: number;
  node: PMNode;
  $pos: ResolvedPos;
}

const blockAt = (state: EditorState, pos: number): ChildBlock => {
  const $pos = state.doc.resolve(pos);
  return { pos, node: $pos.nodeAfter!, $pos };
};

/**
 * What Tab would move into a task: the selected block (a task's grip, an image), the line at the cursor, or the
 * whole list when the cursor is on its very first line (where Tab can't nest the item: a list just below a task).
 * Null inside a list otherwise (Tab nests list items) and in code blocks.
 */
export function tabBlock(state: EditorState): ChildBlock | null {
  const sel = state.selection;
  if (sel instanceof NodeSelection) return blockAt(state, sel.from);
  const { $from } = sel;
  if (!$from.parent.isTextblock || $from.parent.type.name === 'codeBlock') return null;
  const d = $from.depth;
  if (d < 1) return null;
  if (d >= 3 && ITEMS.has($from.node(d - 1).type.name)) {
    const listDepth = d - 2;
    if ($from.index(d - 1) !== 0 || $from.index(listDepth) !== 0) return null;
    if (listDepth < 1 || ITEMS.has($from.node(listDepth - 1).type.name)) return null; // a nested list
    return blockAt(state, $from.before(listDepth));
  }
  for (let k = d - 1; k > 0; k--) if (ITEMS.has($from.node(k).type.name)) return null; // deeper inside a list item
  return blockAt(state, $from.before(d));
}

/** What Shift+Tab would lift out of a task: the selected block or the line at the cursor, when its parent is a task. */
export function shiftTabBlock(state: EditorState): ChildBlock | null {
  const sel = state.selection;
  const b = sel instanceof NodeSelection ? blockAt(state, sel.from) : sel.$from.depth >= 1 && sel.$from.parent.isTextblock ? blockAt(state, sel.$from.before()) : null;
  return b && b.$pos.parent.type.name === TASK ? b : null;
}

/** Where the selection goes when the block it is in moved from `oldStart` to `newStart` (`shift`: extra offset inside it). */
function moveSelection(tr: Transaction, sel: Selection, oldStart: number, newStart: number, shift = 0) {
  if (sel instanceof NodeSelection && sel.from === oldStart) {
    tr.setSelection(NodeSelection.create(tr.doc, newStart));
    return;
  }
  const map = (p: number) => Math.max(0, Math.min(tr.doc.content.size, newStart + (p - oldStart) + (p > oldStart ? shift : 0)));
  const $a = tr.doc.resolve(map(sel.anchor));
  const $h = tr.doc.resolve(map(sel.head));
  tr.setSelection($a.parent.inlineContent && $h.parent.inlineContent ? TextSelection.between($a, $h) : Selection.near($h));
}

/**
 * Tab: move `block` into the task just before it, as its last child. A list joins a list of the same kind that ends
 * the task's children. False when the block before isn't a task.
 */
export function indentIntoTask(state: EditorState, block: ChildBlock | null, dispatch?: (tr: Transaction) => void): boolean {
  if (!block) return false;
  const { $pos, node, pos } = block;
  const index = $pos.index();
  if (index === 0) return false;
  const task = $pos.parent.child(index - 1);
  if (task.type.name !== TASK || !task.type.validContent(task.content.append(Fragment.from(node)))) return false;
  if (!dispatch) return true;
  const insertAt = pos - 1; // the end of the task's content
  const tr = state.tr.delete(pos, pos + node.nodeSize).insert(insertAt, node);
  const last = task.lastChild;
  const join = !(state.selection instanceof NodeSelection) && !!last && LISTS.has(node.type.name) && last.type === node.type;
  if (join) tr.join(insertAt);
  moveSelection(tr, state.selection, pos, insertAt, join ? -2 : 0);
  dispatch(tr.scrollIntoView());
  return true;
}

/** Shift+Tab (and Enter on an empty last child): move `block` out of its task, to just after the task. */
export function liftOutOfTask(state: EditorState, block: ChildBlock | null, dispatch?: (tr: Transaction) => void): boolean {
  if (!block) return false;
  const { $pos, node, pos } = block;
  if ($pos.parent.type.name !== TASK) return false;
  const taskDepth = $pos.depth;
  const container = $pos.node(taskDepth - 1);
  const at = $pos.index(taskDepth - 1) + 1;
  if (!container.canReplaceWith(at, at, node.type)) return false;
  if (!dispatch) return true;
  const taskEnd = $pos.after(taskDepth);
  const tr = state.tr.insert(taskEnd, node).delete(pos, pos + node.nodeSize);
  moveSelection(tr, state.selection, pos, taskEnd - node.nodeSize);
  dispatch(tr.scrollIntoView());
  return true;
}

/** Enter on an empty paragraph that is a task's last child: leave the task (the line moves out, below it). */
export function exitEmptyLastChild(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  const { selection } = state;
  if (!selection.empty || !(selection instanceof TextSelection)) return false;
  const { $from } = selection;
  if ($from.depth < 2 || $from.parent.type.name !== 'paragraph' || $from.parent.content.size) return false;
  const task = $from.node(-1);
  if (task.type.name !== TASK || $from.index(-1) !== task.childCount - 1) return false;
  return liftOutOfTask(state, blockAt(state, $from.before()), dispatch);
}

/** The depth of the task whose first line the cursor's line is (its first child, or the first line of its first list), or -1. */
export function firstLineOfTask($from: ResolvedPos): number {
  for (let d = $from.depth - 1; d > 0; d--) {
    if ($from.index(d) !== 0) return -1;
    if ($from.node(d).type.name === TASK) return d;
  }
  return -1;
}

/**
 * Nested task blocks whose task is gone (`goneTitle` gives its last title, or undefined for a task that still
 * exists) become plain lines: a paragraph with the title, then the notes that were under it.
 */
export function plainGoneTasks(content: Fragment, goneTitle: (id: string) => string | undefined): Fragment {
  const out: PMNode[] = [];
  content.forEach((n) => {
    if (n.isTextblock || n.isLeaf) {
      out.push(n);
      return;
    }
    const kids = plainGoneTasks(n.content, goneTitle);
    const title = n.type.name === TASK ? goneTitle(String(n.attrs.taskId)) : undefined;
    if (title === undefined) out.push(n.copy(kids));
    else {
      const para = n.type.schema.nodes.paragraph;
      if (title) out.push(para.create(null, n.type.schema.text(title)));
      kids.forEach((k) => out.push(k));
    }
  });
  return Fragment.fromArray(out);
}

/**
 * Replace the task at `pos` with its children (nothing when it has none): its notes stay on the page. Subtasks in
 * them that were deleted with it (`goneTitle`) stay as plain lines.
 */
export function unwrapTask(tr: Transaction, pos: number, lead: PMNode[] = [], goneTitle?: (id: string) => string | undefined): Transaction {
  const node = tr.doc.nodeAt(pos);
  if (!node || node.type.name !== TASK) return tr;
  const keep = Fragment.fromArray(lead).append(goneTitle ? plainGoneTasks(node.content, goneTitle) : node.content);
  return keep.size ? tr.replaceWith(pos, pos + node.nodeSize, keep) : tr.delete(pos, pos + node.nodeSize);
}

/**
 * The task a line belongs with, for "Add checklist": the innermost task whose notes it is in, else the task just
 * above it. Its position, or -1.
 */
export function taskNear($pos: ResolvedPos): number {
  for (let d = $pos.depth; d > 0; d--) if ($pos.node(d).type.name === TASK) return $pos.before(d);
  if ($pos.depth < 1) return -1;
  const $line = $pos.doc.resolve($pos.before($pos.depth));
  const prev = $line.nodeBefore;
  return prev?.type.name === TASK ? $line.pos - prev.nodeSize : -1;
}

/**
 * Put an empty plain checklist at the top of a task's notes (its items are never tasks: a packing list under "Pack
 * for the trip"), with the caret in its first item. False when the schema has no checklists.
 */
export function addChecklistToTask(tr: Transaction, taskPos: number): boolean {
  const { schema } = tr.doc.type;
  const task = tr.doc.nodeAt(taskPos);
  const { taskList, taskItem, paragraph } = schema.nodes;
  if (!task || task.type.name !== TASK || !taskList || !taskItem) return false;
  tr.insert(taskPos + 1, taskList.create(null, taskItem.create({ checked: false }, paragraph.create())));
  tr.setSelection(TextSelection.create(tr.doc, taskPos + 4));
  return true;
}

/** Creates a task for a converted line; returns its id, or null to leave the line as it is. */
export type MakeTask = (title: string, done: boolean) => string | null;

/**
 * Turn the line at the cursor, or every line in the selection, into tasks, keeping each line's sub-points (the rest of
 * its list item: nested bullets, paragraphs) as the new task's children, exactly as they were. A line inside a list
 * becomes a task where it is: a list splits around it, and one nested in another item stays nested there. Checked
 * checklist items become done tasks. Images, tables, code and other blocks in a selection are kept as they are.
 * Tasks are only created once the result is known to fit (`makeTask` is called for real only then).
 */
export function convertTransaction(state: EditorState, makeTask: MakeTask): { tr: Transaction; ids: string[] } | null {
  const { selection, doc, schema } = state;
  const taskType = schema.nodes[TASK];
  if (!taskType) return null;
  const { $from, $to } = selection;
  const single = selection.empty || $from.sameParent($to);
  let from: number;
  let to: number;
  if (single) {
    if (!$from.parent.isTextblock || $from.parent.type.name === 'codeBlock' || $from.depth < 1) return null;
    const d = $from.depth;
    const inItem = d >= 3 && ITEMS.has($from.node(d - 1).type.name) && $from.index(d - 1) === 0;
    from = $from.before(inItem ? d - 2 : d);
    to = $from.after(inItem ? d - 2 : d);
  } else {
    let d = $from.sharedDepth(selection.to);
    while (d > 0 && (LISTS.has($from.node(d).type.name) || ITEMS.has($from.node(d).type.name) || $from.node(d).isTextblock)) d--;
    from = $from.before(d + 1);
    to = $to.after(d + 1);
  }
  const selFrom = selection.from;
  const selTo = selection.to;
  const overlaps = (pos: number, node: PMNode) => pos < selTo && pos + node.nodeSize > selFrom;
  // In a selection inside one line, that line (even when the selection is empty or the line too).
  const overlapsLine = (pos: number, node: PMNode) => (single ? pos < Math.max(selTo, selFrom + 1) && pos + node.nodeSize > selFrom : overlaps(pos, node));

  const build = (make: MakeTask) => {
    const ids: string[] = [];
    /** A task for a line (its id made before its notes', so ids come in document order), or null to keep the line. */
    const task = (text: string, done: boolean, notes: () => PMNode[]): PMNode | null => {
      const title = text.trim();
      if (!title && !single) return null;
      const id = make(title, done);
      if (!id) return null;
      ids.push(id);
      return taskType.create({ taskId: id }, Fragment.fromArray(notes()));
    };
    const rebuild = (node: PMNode, pos: number): PMNode[] => {
      if (!overlapsLine(pos, node)) return [node];
      const name = node.type.name;
      // A task in the selection stays as it is, notes and all: only lines selected on their own (the selection
      // inside a task's notes) become subtasks.
      if (name === TASK) return [node];
      if (LISTS.has(name)) return fromList(node, pos);
      if (node.isTextblock && name !== 'codeBlock') {
        const t = task(node.textContent, false, () => []);
        return [t ?? node];
      }
      return [node]; // quotes, callouts, toggles, tables, images: as they are
    };
    const children = (node: PMNode, pos: number, skipFirst = false): PMNode[] => {
      const out: PMNode[] = [];
      node.forEach((c, offset, i) => out.push(...(skipFirst && i === 0 ? [] : rebuild(c, pos + 1 + offset))));
      return out;
    };
    /** A list: its selected items become tasks (with their sub-points); runs of the others stay lists of its kind. */
    const fromList = (list: PMNode, pos: number): PMNode[] => {
      const out: PMNode[] = [];
      let keep: PMNode[] = [];
      let converted = false;
      const flush = () => {
        if (!keep.length) return;
        // Numbers carry on after a converted item (smartLists' `continued`), as when an item is lifted out.
        const attrs = converted && list.type.name === 'orderedList' && 'continued' in list.attrs ? { ...list.attrs, start: 1, continued: true } : list.attrs;
        out.push(list.type.create(attrs, keep));
        keep = [];
      };
      list.forEach((item, offset) => {
        const itemPos = pos + 1 + offset;
        if (!overlapsLine(itemPos, item)) {
          keep.push(item);
          return;
        }
        const first = item.firstChild;
        if (first?.isTextblock && overlapsLine(itemPos + 1, first)) {
          // Its sub-points come along exactly as they are, never as tasks of their own (a 25-item packing list under
          // "Pack for the trip" stays a checklist), even when the selection covers them too.
          const rest: PMNode[] = [];
          item.forEach((c, _o, i) => i > 0 && rest.push(c));
          const t = task(first.textContent, item.type.name === 'taskItem' && !!item.attrs.checked, () => rest);
          if (t) {
            flush();
            out.push(t);
            converted = true;
            return;
          }
          keep.push(item.copy(Fragment.fromArray([first, ...children(item, itemPos, true)]))); // an empty line: its sub-points may still convert
          return;
        }
        keep.push(item.copy(Fragment.fromArray(children(item, itemPos))));
      });
      flush();
      return out;
    };
    const $start = doc.resolve(from);
    const parent = $start.parent;
    const startIndex = $start.index();
    const out: PMNode[] = [];
    let i = startIndex;
    for (let pos = from; pos < to; i++) {
      const child = parent.child(i);
      out.push(...rebuild(child, pos));
      pos += child.nodeSize;
    }
    return { out, ids, parent, startIndex, endIndex: i };
  };

  // Dry run first: no task is created unless the converted blocks fit where they go.
  let n = 0;
  const dry = build(() => `dry-${n++}`);
  if (!dry.ids.length || !dry.parent.canReplace(dry.startIndex, dry.endIndex, Fragment.fromArray(dry.out))) return null;
  try {
    for (const node of dry.out) node.check();
  } catch {
    return null;
  }
  const real = build(makeTask);
  if (!real.ids.length) return null;
  const tr = state.tr.replaceWith(from, to, real.out);
  return { tr: tr.scrollIntoView(), ids: real.ids };
}
