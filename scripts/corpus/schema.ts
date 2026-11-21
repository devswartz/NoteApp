// The editor's document schema for building corpus pages in Node. It mirrors
// documentExtensions() in src/editor/NoteEditor.tsx: the same node and mark names, attributes and
// content rules, without the React node views and app stores those files import. When the editor
// gains a block, mark or attribute, add it here and a case for it in ./cases.ts.
import { Mark, Node, Extension, getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import ImageExt from '@tiptap/extension-image';
import { CodeBlock } from '@tiptap/extension-code-block';
import { Details, DetailsContent, DetailsSummary } from '@tiptap/extension-details';
import { colorExtensions } from '../../src/editor/colors.ts';

const attrs = (defs: Record<string, unknown>) => () => Object.fromEntries(Object.entries(defs).map(([k, d]) => [k, { default: d }]));

// src/editor/blocks.tsx
const Callout = Node.create({ name: 'callout', group: 'block', content: 'block+', defining: true, addAttributes: attrs({ emoji: '💡' }) });
const FileAttachment = Node.create({ name: 'fileAttachment', group: 'block', atom: true, addAttributes: attrs({ url: '', name: 'file', size: 0, mime: '' }) });
// src/editor/TaskRef.tsx: the task's notes are its content.
const TaskRef = Node.create({ name: 'taskRef', group: 'block', content: 'block*', isolating: true, addAttributes: attrs({ taskId: null }) });
// src/editor/PageLink.tsx, src/editor/collabMentions.ts
const PageLink = Node.create({ name: 'pageLink', group: 'inline', inline: true, atom: true, addAttributes: attrs({ pageId: null }) });
const Mention = Node.create({ name: 'mention', group: 'inline', inline: true, atom: true, addAttributes: attrs({ id: null, label: '' }) });
// src/editor/collabComments.ts: overlapping threads, so y-prosemirror stores it as `comment--<hash>`.
const Comment = Mark.create({ name: 'comment', inclusive: false, excludes: '', addAttributes: attrs({ threadId: null }) });
// src/editor/smartLists.ts
const SmartLists = Extension.create({
  name: 'smartLists',
  addGlobalAttributes: () => [{ types: ['orderedList'], attributes: { paren: { default: false }, continued: { default: false } } }],
});

export const schema = getSchema([
  StarterKit.configure({ undoRedo: false, codeBlock: false, heading: { levels: [1, 2, 3] } }),
  TaskList,
  TaskItem.configure({ nested: true }),
  TableKit,
  ImageExt,
  CodeBlock,
  Callout,
  FileAttachment,
  Details,
  DetailsSummary,
  DetailsContent,
  TaskRef,
  PageLink,
  ...colorExtensions,
  Mention,
  Comment,
  SmartLists,
]);
