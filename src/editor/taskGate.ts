// Where this user may create tasks from the editor. Kept dependency-free so the slash menu and
// ribbon can ask without pulling in the task node view (and its styles).
import type { Editor } from '@tiptap/core';

/**
 * Pages on which this user can't create tasks: opened through a page share from outside the
 * page's workspace (#98). They may edit the page's text, but tasks belong to workspace members.
 * PageView sets this from GET /pages/:id; the server refuses such tasks anyway.
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

/** May this editor's user create tasks on its page? */
export const canInsertTask = (editor: Editor) => tasksAllowedOn(pageIdOf(editor));
