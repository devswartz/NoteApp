// Where this user may create tasks from the editor. Kept dependency-free so the slash menu and
// ribbon can ask without pulling in the task node view (and its styles).
import type { Editor } from '@tiptap/core';

/**
 * Pages on which this user can't create tasks: those they can't edit. Whoever may edit a page may
 * add tasks to it, through a page share from outside its workspace too (#98 follow-up); the task
 * goes to the page's workspace. PageView sets this from GET /pages/:id; the server checks anyway.
 */
const noTaskPages = new Set<string>();

export function setTasksAllowed(pageId: string, allowed: boolean) {
  if (allowed) noTaskPages.delete(pageId);
  else noTaskPages.add(pageId);
}

export const tasksAllowedOn = (pageId: string) => !noTaskPages.has(pageId);

/** The page an editor edits (the taskRef extension's `pageId` option). */
export const pageIdOf = (editor: Editor): string =>
  (editor.extensionManager.extensions.find((x) => x.name === 'taskRef')?.options as { pageId?: string } | undefined)?.pageId ?? '';

/**
 * Is the editor's content empty? Tiptap's `isEmpty` counts a task block with no notes under it as empty (a task block
 * holds optional content, and its line lives in the task itself), so a box holding only tasks would look empty and be
 * cleaned away. Use this instead of `editor.isEmpty` wherever emptiness decides anything.
 */
export function editorIsEmpty(editor: Editor): boolean {
  if (!editor.isEmpty) return false;
  let task = false;
  editor.state.doc.descendants((n) => {
    if (n.type.name === 'taskRef') task = true;
    return !task;
  });
  return !task;
}

/** May this editor's user create tasks on its page? */
export const canInsertTask = (editor: Editor) => tasksAllowedOn(pageIdOf(editor));
