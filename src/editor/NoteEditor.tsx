import { useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import { TableKit } from '@tiptap/extension-table';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import ImageExt from '@tiptap/extension-image';
import { Placeholder, TrailingNode } from '@tiptap/extensions';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';
import {
  Bold,
  CircleCheck,
  Code,
  Heading1,
  Heading2,
  Italic,
  Link2,
  Strikethrough,
  Underline,
  Rows3,
  Columns3,
  Trash2,
} from 'lucide-react';
import { TaskRef } from './TaskRef.tsx';
import { SlashCommand, SlashMenuView, slashHooks } from './SlashMenu.tsx';
import { getToken, upload } from '../api.ts';
import { errorToast } from '../store.ts';
import type { User } from '../../shared/types.ts';

export type SyncStatus = 'connecting' | 'live' | 'offline';
export interface PresenceUser {
  id: string;
  name: string;
  color: string;
}

/** Plain checklist items; the "[] " input rule is reserved for real tasks. */
const PlainTaskItem = TaskItem.extend({
  addInputRules() {
    return [];
  },
}).configure({ nested: true });

function collabUrl() {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/collab`;
}

interface Props {
  pageId: string;
  user: User;
  canEdit: boolean;
  onStatus: (s: SyncStatus) => void;
  onPresence: (users: PresenceUser[]) => void;
  onReady: (editor: Editor) => void;
}

export function NoteEditor({ pageId, user, canEdit, onStatus, onPresence, onReady }: Props) {
  // One Y.Doc + providers per page (component is keyed by page id).
  const { doc, provider } = useMemo(() => {
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(collabUrl(), pageId, doc, {
      params: { token: getToken() ?? '' },
      // Stop retrying on auth/permission failures.
    });
    return { doc, provider };
  }, [pageId]);
  const [synced, setSynced] = useState(false);

  useEffect(() => {
    // Local cache for offline reading/editing; merges when the socket reconnects.
    const idb = new IndexeddbPersistence(`noteapp-page-${pageId}`, doc);
    const onStatusEv = ({ status }: { status: string }) =>
      onStatus(status === 'connected' ? 'live' : status === 'connecting' ? 'connecting' : 'offline');
    const onSync = (s: boolean) => s && setSynced(true);
    idb.once('synced', () => setSynced(true));
    provider.on('status', onStatusEv);
    provider.on('sync', onSync);
    provider.on('connection-close', (ev: CloseEvent | null) => {
      if (ev && (ev.code === 4401 || ev.code === 4403)) {
        provider.shouldConnect = false;
        onStatus('offline');
      }
    });
    const onAwareness = () => {
      const seen = new Map<string, PresenceUser>();
      provider.awareness.getStates().forEach((s, clientId) => {
        const u = s.user as PresenceUser | undefined;
        if (u && clientId !== doc.clientID && u.id !== user.id) seen.set(u.id, u);
      });
      onPresence([...seen.values()]);
    };
    provider.awareness.on('change', onAwareness);
    return () => {
      provider.awareness.off('change', onAwareness);
      provider.destroy();
      void idb.destroy();
      doc.destroy();
    };
  }, [doc, provider]); // eslint-disable-line react-hooks/exhaustive-deps

  const editor = useEditor(
    {
      editable: canEdit,
      extensions: [
        StarterKit.configure({
          undoRedo: false, // Collaboration provides collaborative undo
          link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' } },
          heading: { levels: [1, 2, 3] },
        }),
        Placeholder.configure({
          includeChildren: false,
          placeholder: ({ node }) =>
            node.type.name === 'heading' ? 'Heading' : "Type '/' for commands, '[]' for a task…",
        }),
        TrailingNode,
        TaskList,
        PlainTaskItem,
        TableKit.configure({ table: { resizable: true } }),
        ImageExt.configure({ allowBase64: false }),
        TaskRef.configure({ pageId }),
        SlashCommand,
        Collaboration.configure({ document: doc, field: 'default' }),
        CollaborationCaret.configure({
          provider,
          user: { id: user.id, name: user.name, color: user.color },
        }),
      ],
      editorProps: {
        attributes: { class: 'prose', spellcheck: 'true' },
        handlePaste: (view, event) => {
          const files = [...(event.clipboardData?.files ?? [])];
          if (!files.length) return false;
          void insertFiles(editorRef.current!, files, view.state.selection.from);
          return true;
        },
        handleDrop: (view, event, _slice, moved) => {
          const files = [...((event as DragEvent).dataTransfer?.files ?? [])];
          if (moved || !files.length) return false;
          const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? view.state.selection.from;
          void insertFiles(editorRef.current!, files, pos);
          return true;
        },
      },
    },
    [pageId],
  );
  const editorRef = useRef<Editor | null>(null);
  editorRef.current = editor;

  useEffect(() => {
    editor?.setEditable(canEdit);
  }, [editor, canEdit]);

  useEffect(() => {
    if (editor) onReady(editor);
  }, [editor]); // eslint-disable-line react-hooks/exhaustive-deps

  // File pickers for the slash menu.
  const imageInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    slashHooks.pickImage = () => imageInput.current?.click();
    slashHooks.pickFile = () => fileInput.current?.click();
  }, []);

  return (
    <div className={`editor-wrap ${synced ? '' : 'is-loading'}`}>
      {editor && canEdit && <FormattingMenu editor={editor} />}
      {editor && canEdit && <TableBar editor={editor} />}
      <EditorContent editor={editor} />
      <SlashMenuView />
      <input
        ref={imageInput}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          if (editor && e.target.files?.length) void insertFiles(editor, [...e.target.files], editor.state.selection.from);
          e.target.value = '';
        }}
      />
      <input
        ref={fileInput}
        type="file"
        hidden
        onChange={(e) => {
          if (editor && e.target.files?.length) void insertFiles(editor, [...e.target.files], editor.state.selection.from);
          e.target.value = '';
        }}
      />
    </div>
  );
}

async function insertFiles(editor: Editor, files: File[], pos: number) {
  for (const file of files) {
    try {
      const r = await upload(file);
      if (file.type.startsWith('image/')) {
        editor.chain().focus().insertContentAt(pos, { type: 'image', attrs: { src: r.url, alt: r.name } }).run();
      } else {
        editor
          .chain()
          .focus()
          .insertContentAt(pos, {
            type: 'paragraph',
            content: [{ type: 'text', text: `📎 ${r.name} (${formatSize(r.size)})`, marks: [{ type: 'link', attrs: { href: r.url } }] }],
          })
          .run();
      }
    } catch (e) {
      errorToast(e);
    }
  }
}

function formatSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
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
        return !empty && e.isEditable && !e.isActive('taskRef') && !e.isActive('image') && !e.isActive('codeBlock');
      }}
    >
      {btn(s.h1, 'Heading 1', () => editor.chain().focus().toggleHeading({ level: 1 }).run(), <Heading1 size={16} />)}
      {btn(s.h2, 'Heading 2', () => editor.chain().focus().toggleHeading({ level: 2 }).run(), <Heading2 size={16} />)}
      <span className="bm-sep" />
      {btn(s.bold, 'Bold (⌘B)', () => editor.chain().focus().toggleBold().run(), <Bold size={16} />)}
      {btn(s.italic, 'Italic (⌘I)', () => editor.chain().focus().toggleItalic().run(), <Italic size={16} />)}
      {btn(s.underline, 'Underline (⌘U)', () => editor.chain().focus().toggleUnderline().run(), <Underline size={16} />)}
      {btn(s.strike, 'Strikethrough', () => editor.chain().focus().toggleStrike().run(), <Strikethrough size={16} />)}
      {btn(s.code, 'Inline code', () => editor.chain().focus().toggleCode().run(), <Code size={16} />)}
      {btn(s.link, 'Link', () => {
        if (editor.isActive('link')) return editor.chain().focus().unsetLink().run();
        const url = prompt('Link URL');
        if (url) editor.chain().focus().setLink({ href: /^(https?:|mailto:|\/)/.test(url) ? url : `https://${url}` }).run();
      }, <Link2 size={16} />)}
      <span className="bm-sep" />
      <button
        type="button"
        className="bm-btn bm-text"
        title="Turn into task (⌘↵)"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => editor.chain().focus().convertBlockToTask().run()}
      >
        <CircleCheck size={16} /> Task
      </button>
    </BubbleMenu>
  );
}

function TableBar({ editor }: { editor: Editor }) {
  const inTable = useEditorState({ editor, selector: ({ editor: e }) => e.isActive('table') });
  if (!inTable) return null;
  const b = (title: string, fn: () => void, icon: React.ReactNode) => (
    <button type="button" className="btn-ghost btn-sm" onMouseDown={(e) => e.preventDefault()} onClick={fn}>
      {icon} {title}
    </button>
  );
  return (
    <div className="table-bar">
      {b('Row', () => editor.chain().focus().addRowAfter().run(), <Rows3 size={14} />)}
      {b('Column', () => editor.chain().focus().addColumnAfter().run(), <Columns3 size={14} />)}
      {b('Delete row', () => editor.chain().focus().deleteRow().run(), <Rows3 size={14} />)}
      {b('Delete column', () => editor.chain().focus().deleteColumn().run(), <Columns3 size={14} />)}
      {b('Delete table', () => editor.chain().focus().deleteTable().run(), <Trash2 size={14} />)}
    </div>
  );
}
