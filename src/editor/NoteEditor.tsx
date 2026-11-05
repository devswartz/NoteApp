import { useEffect, useRef } from 'react';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import type { Extensions } from '@tiptap/core';
import { BubbleMenu } from '@tiptap/react/menus';
import { beginComment, useCommentBinding } from './collabComments.ts';
import { DragHandle } from '@tiptap/extension-drag-handle-react';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Details, DetailsContent, DetailsSummary } from '@tiptap/extension-details';
import { Placeholder } from '@tiptap/extensions';
import { TextSelection } from '@tiptap/pm/state';
import {
  MessageSquare,
  Bold,
  CircleCheck,
  Code,
  GripVertical,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link2,
  Plus,
  Quote,
  Strikethrough,
  Underline,
  Rows3,
  Columns3,
  Trash2,
  ArrowDownToLine,
  ArrowRightToLine,
  PanelTop,
} from 'lucide-react';
import { TaskRef } from './TaskRef.tsx';
import { SlashCommand, SlashMenuView, slashHooks } from './SlashMenu.tsx';
import { Callout, CodeBlock, FileAttachment, Image } from './blocks.tsx';
import { LinkEditorView, openLinkEditor } from './LinkEditor.tsx';
import { PageLink, PageLinkMenuView } from './PageLink.tsx';
import { collabExtensions, useCollab, type PresenceUser, type SaveState, type SyncStatus } from './collab.ts';
import { uploadFile } from './upload.ts';
import { errorToast, toast } from '../store.ts';
import type { User } from '../../shared/types.ts';
import { platform } from '../platform/index.ts';
import '../styles/editor.css';

export type { PresenceUser, SaveState, SyncStatus };

/** Plain checklist items; the "[] " input rule is reserved for real tasks. */
const PlainTaskItem = TaskItem.extend({
  addInputRules() {
    return [];
  },
}).configure({ nested: true });

interface Props {
  pageId: string;
  workspaceId: string;
  user: User;
  canEdit: boolean;
  onStatus: (s: SyncStatus) => void;
  onPresence: (users: PresenceUser[]) => void;
  onSave?: (s: SaveState) => void;
  /** Called once the server's copy of the page has been loaded. */
  onServerSynced?: () => void;
  onReady: (editor: Editor) => void;
}

/**
 * The document schema and node views shared by the live editor and read-only views
 * (version history preview): everything except collaboration and the slash menu.
 */
export function documentExtensions(pageId: string): Extensions {
  return [
    StarterKit.configure({
      undoRedo: false, // Collaboration provides collaborative undo
      codeBlock: false, // replaced by CodeBlock (syntax highlighting + language picker)
      link: {
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        defaultProtocol: 'https',
        HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
      },
      heading: { levels: [1, 2, 3] },
    }),
    Placeholder.configure({
      includeChildren: true,
      placeholder: ({ node, editor: e }) => {
        if (node.type.name === 'heading') return `Heading ${node.attrs.level}`;
        if (node.type.name === 'detailsSummary') return 'Toggle';
        if (e.isActive('callout') || e.isActive('details')) return 'Type something…';
        return "Type '/' for commands, '[]' for a task…";
      },
    }),
    TaskList,
    PlainTaskItem,
    TableKit.configure({ table: { resizable: true } }),
    Image,
    CodeBlock,
    Callout,
    FileAttachment,
    Details.configure({ persist: false, HTMLAttributes: { class: 'toggle' } }),
    DetailsSummary,
    DetailsContent,
    TaskRef.configure({ pageId }),
    PageLink.configure({ pageId }),
  ];
}

export function NoteEditor({ pageId, workspaceId, user, canEdit, onStatus, onPresence, onSave, onServerSynced, onReady }: Props) {
  const session = useCollab(pageId, user, { onStatus, onPresence, onSave });
  const target = useRef({ pageId, workspaceId });
  target.current = { pageId, workspaceId };

  const editor = useEditor(
    {
      editable: canEdit,
      extensions: [
        ...documentExtensions(pageId),
        SlashCommand,
        ...collabExtensions(session, user),
      ],
      editorProps: {
        attributes: { class: 'prose', spellcheck: 'true' },
        handleKeyDown: (_view, event) => {
          // ⌘K with text selected (or inside a link) edits the link; otherwise it opens the command palette.
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && !event.shiftKey && editorRef.current) {
            if (openLinkEditor(editorRef.current)) {
              event.preventDefault();
              event.stopPropagation();
              return true;
            }
          }
          return false;
        },
        handlePaste: (view, event) => {
          const files = [...(event.clipboardData?.files ?? [])];
          if (!files.length) return false;
          void insertFiles(editorRef.current!, files, view.state.selection.from, target.current);
          return true;
        },
        handleDrop: (view, event, _slice, moved) => {
          const files = [...((event as DragEvent).dataTransfer?.files ?? [])];
          if (moved || !files.length) return false;
          const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? view.state.selection.from;
          void insertFiles(editorRef.current!, files, pos, target.current);
          return true;
        },
      },
    },
    [pageId],
  );
  const editorRef = useRef<Editor | null>(null);
  editorRef.current = editor;

  useEffect(() => {
    if (session.serverSynced) onServerSynced?.();
  }, [session.serverSynced]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    editor?.setEditable(canEdit);
  }, [editor, canEdit]);

  useEffect(() => {
    if (editor) onReady(editor);
  }, [editor]); // eslint-disable-line react-hooks/exhaustive-deps
  useCommentBinding(editor);

  // File pickers for the slash menu.
  useEffect(() => {
    const pick = async (ed: Editor, accept?: string) => {
      const files = await platform.pickFiles({ accept, multiple: true });
      if (files.length) void insertFiles(ed, files, ed.state.selection.from, target.current);
    };
    slashHooks.pickImage = (ed) => void pick(ed, 'image/*');
    slashHooks.pickFile = (ed) => void pick(ed);
    slashHooks.editLink = (ed) => openLinkEditor(ed);
  }, []);

  return (
    <div className={`editor-wrap ${session.synced ? '' : 'is-loading'}`}>
      {editor && canEdit && <FormattingMenu editor={editor} />}
      {editor && canEdit && <TableBar editor={editor} />}
      {editor && canEdit && <BlockHandle editor={editor} />}
      <EditorContent editor={editor} />
      <SlashMenuView />
      <PageLinkMenuView />
      <LinkEditorView />
    </div>
  );
}

/** Upload files and insert each as an image or a file card at `pos`. */
export async function insertFiles(editor: Editor, files: File[], pos: number, at: { pageId: string; workspaceId: string }) {
  for (const file of files) {
    try {
      if (file.size > 1024 * 1024) toast(`Uploading ${file.name}…`);
      const r = await uploadFile(file, at.workspaceId, at.pageId);
      if (editor.isDestroyed) return;
      const p = Math.min(pos, editor.state.doc.content.size);
      if (r.mime.startsWith('image/') && r.mime !== 'image/heic') {
        editor.chain().focus().insertContentAt(p, { type: 'image', attrs: { src: r.url, alt: r.name } }).run();
      } else {
        editor.chain().focus().insertFileAttachment({ url: r.url, name: r.name, size: r.size, mime: r.mime }, p).run();
      }
      pos = editor.state.selection.to;
    } catch (e) {
      errorToast(e);
    }
  }
}

/** Notion-style handle left of each block: drag to move, click to select, "+" to insert below. */
function BlockHandle({ editor }: { editor: Editor }) {
  const current = useRef<{ pos: number; size: number } | null>(null);
  return (
    <DragHandle
      editor={editor}
      className="block-handle"
      onNodeChange={({ node, pos }) => {
        current.current = node ? { pos, size: node.nodeSize } : null;
      }}
    >
      <button
        type="button"
        className="block-handle-btn"
        title="Insert below"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          const c = current.current;
          if (!c) return;
          const at = c.pos + c.size;
          editor
            .chain()
            .insertContentAt(at, { type: 'paragraph' })
            .command(({ tr }) => {
              tr.setSelection(TextSelection.create(tr.doc, at + 1));
              return true;
            })
            .insertContent('/') // opens the slash menu
            .focus()
            .run();
        }}
      >
        <Plus size={15} />
      </button>
      <span className="block-handle-btn block-handle-grip" title="Drag to move · click to select" data-drag-handle>
        <GripVertical size={15} />
      </span>
    </DragHandle>
  );
}

function FormattingMenu({ editor }: { editor: Editor }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      link: e.isActive('link'),
      h1: e.isActive('heading', { level: 1 }),
      h2: e.isActive('heading', { level: 2 }),
      h3: e.isActive('heading', { level: 3 }),
      quote: e.isActive('blockquote'),
    }),
  });
  const btn = (active: boolean, title: string, onClick: () => void, icon: React.ReactNode) => (
    <button type="button" className={`bm-btn ${active ? 'is-active' : ''}`} title={title} aria-label={title} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
      {icon}
    </button>
  );
  return (
    <BubbleMenu
      editor={editor}
      className="bubble-menu"
      shouldShow={({ editor: e, state }) => {
        const { empty } = state.selection;
        if (empty || e.isDestroyed || !e.isEditable || !e.isFocused) return false;
        if (state.selection instanceof TextSelection === false) return false; // node selections (images, files, tasks)
        return !e.isActive('codeBlock');
      }}
    >
      {btn(s.h1, 'Heading 1', () => editor.chain().focus().toggleHeading({ level: 1 }).run(), <Heading1 size={16} />)}
      {btn(s.h2, 'Heading 2', () => editor.chain().focus().toggleHeading({ level: 2 }).run(), <Heading2 size={16} />)}
      {btn(s.h3, 'Heading 3', () => editor.chain().focus().toggleHeading({ level: 3 }).run(), <Heading3 size={16} />)}
      {btn(s.quote, 'Quote', () => editor.chain().focus().toggleBlockquote().run(), <Quote size={16} />)}
      <span className="bm-sep" />
      {btn(s.bold, 'Bold (⌘B)', () => editor.chain().focus().toggleBold().run(), <Bold size={16} />)}
      {btn(s.italic, 'Italic (⌘I)', () => editor.chain().focus().toggleItalic().run(), <Italic size={16} />)}
      {btn(s.underline, 'Underline (⌘U)', () => editor.chain().focus().toggleUnderline().run(), <Underline size={16} />)}
      {btn(s.strike, 'Strikethrough (⌘⇧S)', () => editor.chain().focus().toggleStrike().run(), <Strikethrough size={16} />)}
      {btn(s.code, 'Inline code (⌘E)', () => editor.chain().focus().toggleCode().run(), <Code size={16} />)}
      {btn(s.link, 'Link (⌘K)', () => openLinkEditor(editor), <Link2 size={16} />)}
      <span className="bm-sep" />
      <button
        type="button"
        className="bm-btn bm-text"
        title="Turn into task (⌘↵)"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => editor.chain().focus().convertToTask().run()}
      >
        <CircleCheck size={16} /> Task
      </button>
      <button type="button" className="bm-btn bm-text" title="Comment" onMouseDown={(e) => e.preventDefault()} onClick={() => beginComment(editor)}>
        <MessageSquare size={16} /> Comment
      </button>
    </BubbleMenu>
  );
}

function TableBar({ editor }: { editor: Editor }) {
  const inTable = useEditorState({ editor, selector: ({ editor: e }) => e.isActive('table') });
  if (!inTable) return null;
  const b = (title: string, fn: () => void, icon: React.ReactNode, label = title) => (
    <button type="button" className="btn-ghost btn-sm" title={title} onMouseDown={(e) => e.preventDefault()} onClick={fn}>
      {icon} {label}
    </button>
  );
  return (
    <div className="table-bar" contentEditable={false}>
      {b('Add row below', () => editor.chain().focus().addRowAfter().run(), <ArrowDownToLine size={14} />, 'Row')}
      {b('Add column right', () => editor.chain().focus().addColumnAfter().run(), <ArrowRightToLine size={14} />, 'Column')}
      {b('Toggle header row', () => editor.chain().focus().toggleHeaderRow().run(), <PanelTop size={14} />, 'Header')}
      <span className="bm-sep" />
      {b('Delete row', () => editor.chain().focus().deleteRow().run(), <Rows3 size={14} />, 'Delete row')}
      {b('Delete column', () => editor.chain().focus().deleteColumn().run(), <Columns3 size={14} />, 'Delete column')}
      {b('Delete table', () => editor.chain().focus().deleteTable().run(), <Trash2 size={14} />, 'Delete table')}
    </div>
  );
}
