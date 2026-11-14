import { useCallback, useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import { Extension, type Extensions } from '@tiptap/core';
import type { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import { BubbleMenu } from '@tiptap/react/menus';
import { beginComment, useCommentBinding } from './collabComments.ts';
import { DragHandle } from '@tiptap/extension-drag-handle-react';
import { installHandleReach } from './handleReach.ts';
import { listDropTransaction } from './listDrop.ts';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Markdown } from '@tiptap/markdown';
import { Placeholder } from '@tiptap/extensions';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
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
import { TaskRef, canConvert, convertToTasks } from './TaskRef.tsx';
import { colorExtensions } from './colors.ts';
import { ColorMenu, focusFixedToolbar, toolbarKeys } from './Toolbar.tsx';
import { clearActiveEditor, setActiveEditor } from './activeEditor.ts';
import { LongPage } from './longPage.ts';
import { BlockMove } from './blockMove.ts';
import { BlockExit } from './blockExit.ts';
import { SmartLists } from './smartLists.ts';
import { UndoTasks } from './undoTasks.ts';
import { SlashCommand, SlashMenuView, slashHooks } from './SlashMenu.tsx';
import { Callout, CodeBlock, FileAttachment, Image, Toggle, ToggleContent, ToggleSummary } from './blocks.tsx';
import { LinkEditorView, openLinkEditor } from './LinkEditor.tsx';
import { PageLink, PageLinkMenuView } from './PageLink.tsx';
import { MentionNode } from './collabMentions.ts';
import { collabExtensions, useCollab, usePresenceRole, type CollabSession, type PresenceUser, type SaveState, type SyncStatus } from './collab.ts';
import { uploadFile } from './upload.ts';
import { safeLinkUrl } from './urls.ts';
import { errorToast, toast } from '../store.ts';
import type { User } from '../../shared/types.ts';
import { platform } from '../platform/index.ts';
import { ENTER, MOD, MenuItem, Popover, SHIFT, keyLabel, useIsMobile } from '../components/ui.tsx';
import '../styles/editor.css';

export type { PresenceUser, SaveState, SyncStatus };

/** Plain checklist items. Typing "[ ] " does nothing special: real tasks are inserted with /task. */
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
  /** The page's awareness (cursors and presence), e.g. to follow a collaborator (./collabFollow.ts). */
  onAwareness?: (awareness: Awareness | null) => void;
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
        // One rule for pasted HTML, typed links, imports and rendering (see urls.ts).
        isAllowedUri: (url) => !!safeLinkUrl(url),
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
        return "Type '/' for commands…";
      },
    }),
    TaskList,
    PlainTaskItem,
    TableKit.configure({ table: { resizable: true } }),
    Image,
    CodeBlock,
    Callout,
    FileAttachment,
    Toggle,
    ToggleSummary,
    ToggleContent,
    TaskRef.configure({ pageId }),
    PageLink.configure({ pageId }),
    ...colorExtensions, // text colour + highlight, stored as palette names (./colors.ts)
    MentionNode, // @mentions (./collabMentions.ts); the server notifies newly mentioned people on save
    Markdown, // editor.getMarkdown(), and insertContent(md, { contentType: 'markdown' })
    OneNoteKeys,
    SmartLists, // Word-style outlines: list attributes (paren markers, continued numbering), "a. " / "1) " rules, Tab nests, Enter on an empty item outdents
  ];
}

/**
 * Shortcuts OneNote users expect, on top of TipTap's own (Ctrl+Alt+1/2/3 headings come from
 * StarterKit): Ctrl+1 makes a task (where OneNote's To Do tag was; a task is what people
 * mean here), Ctrl+. bullets.
 */
const OneNoteKeys = Extension.create({
  name: 'oneNoteKeys',
  addKeyboardShortcuts() {
    return {
      'Mod-1': () => this.editor.commands.convertToTask() || this.editor.commands.insertTask(),
      'Mod-.': () => this.editor.commands.toggleBulletList(),
    };
  },
});

export function NoteEditor({ pageId, workspaceId, user, canEdit, onStatus, onPresence, onSave, onServerSynced, onReady, onAwareness }: Props) {
  const session = useCollab(pageId, user, { onStatus, onPresence, onSave });
  useEffect(() => {
    onAwareness?.(session.provider.awareness);
    return () => onAwareness?.(null);
  }, [session, onAwareness]);
  usePresenceRole(session, user, canEdit); // others see 'editing' or 'viewing'
  const editor = usePageEditor(session, { pageId, workspaceId, user, canEdit, long: true });

  useEffect(() => {
    if (session.serverSynced) onServerSynced?.();
  }, [session.serverSynced]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (editor) onReady(editor);
  }, [editor]); // eslint-disable-line react-hooks/exhaustive-deps

  // A document has one editor: the ribbon acts on it whenever it is editable.
  useEffect(() => {
    if (!editor || !canEdit) return;
    setActiveEditor(editor);
    const onFocus = () => setActiveEditor(editor);
    editor.on('focus', onFocus);
    return () => {
      editor.off('focus', onFocus);
      clearActiveEditor(editor);
    };
  }, [editor, canEdit]);
  useCommentBinding(editor);
  useSlashFilePickers(pageId, workspaceId);

  return (
    <div className={`editor-wrap ${session.synced ? '' : 'is-loading'}`}>
      {editor && canEdit && <EditorChrome editor={editor} />}
      <EditorContent editor={editor} />
      <EditorMenus />
    </div>
  );
}

export interface PageEditorOptions {
  pageId: string;
  workspaceId: string;
  user: User;
  canEdit: boolean;
  /** The Y.Doc fragment to edit: 'default' for documents, 'box:<id>' for a canvas box. */
  field?: string;
  /** Render-skipping for long pages (documents only; boxes are short). */
  long?: boolean;
  /** Accessible name of the editable area. */
  label?: string;
  /** More extensions (e.g. canvas box keys). */
  extensions?: Extensions;
  /** The text history to use, when it must outlive the editor (canvas boxes; pageUndo.ts). */
  undoManager?: Y.UndoManager;
}

/**
 * A rich-text editor bound to one fragment of the page's shared doc: the document
 * schema, the slash menu, tasks, uploads and collaboration (carets share the page's awareness).
 */
export function usePageEditor(session: CollabSession, { pageId, workspaceId, user, canEdit, field = 'default', long = false, label = 'Page content', extensions = [], undoManager }: PageEditorOptions): Editor | null {
  const target = useRef({ pageId, workspaceId });
  target.current = { pageId, workspaceId };
  const editorRef = useRef<Editor | null>(null);
  const editor = useEditor(
    {
      editable: canEdit,
      extensions: [
        ...documentExtensions(pageId),
        BlockMove, // Alt+Shift+↑/↓ moves blocks
        BlockExit, // Backspace/Enter on an empty last line leaves a toggle, callout or quote
        UndoTasks, // undoing a convert-to-task removes the task it created
        SlashCommand,
        ...(long ? [LongPage] : []), // long pages: render-skipping CSS away from the cursor
        ...collabExtensions(session, user, field, undoManager),
        ...extensions,
      ],
      editorProps: {
        // autocorrect/autocapitalize: WebKit (iOS app, Safari) - explicit so a parent can't turn them off.
        attributes: { class: 'prose', spellcheck: 'true', autocorrect: 'on', autocapitalize: 'sentences', 'aria-label': label, 'aria-multiline': 'true' },
        handleKeyDown: (_view, event) => {
          // Alt+F10 moves focus into a toolbar (WAI-ARIA toolbar pattern): the floating one
          // over selected text, otherwise the fixed one at the top.
          if (event.altKey && event.key === 'F10') {
            if (_view.state.selection.empty && !focusFixedToolbar()) return false;
            event.preventDefault();
            if (!_view.state.selection.empty) focusToolbar();
            return true;
          }
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
          // A dragged list item keeps its list's type and attributes (listDrop.ts).
          if (moved) {
            const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
            const tr = at === undefined ? null : listDropTransaction(view.state, at);
            if (tr) {
              view.dispatch(tr);
              return true;
            }
          }
          const files = [...((event as DragEvent).dataTransfer?.files ?? [])];
          if (moved || !files.length) return false;
          const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? view.state.selection.from;
          void insertFiles(editorRef.current!, files, pos, target.current);
          return true;
        },
      },
    },
    [pageId, field],
  );
  editorRef.current = editor;
  useEffect(() => {
    editor?.setEditable(canEdit);
  }, [editor, canEdit]);
  return editor;
}

/** File pickers for the slash menu ("/image", "/file"); once per page view. */
export function useSlashFilePickers(pageId: string, workspaceId: string) {
  const target = useRef({ pageId, workspaceId });
  target.current = { pageId, workspaceId };
  useEffect(() => {
    const pick = async (ed: Editor, accept?: string) => {
      const files = await platform.pickFiles({ accept, multiple: true });
      if (files.length) void insertFiles(ed, files, ed.state.selection.from, target.current);
    };
    slashHooks.pickImage = (ed) => void pick(ed, 'image/*');
    slashHooks.pickFile = (ed) => void pick(ed);
    slashHooks.editLink = (ed) => openLinkEditor(ed, { insert: true });
  }, []);
}

/** The floating bits that belong to one editor: the bubble menu, the table menu (phones), the image bar, and the block handle. */
export function EditorChrome({ editor, handle = true }: { editor: Editor; handle?: boolean }) {
  const isMobile = useIsMobile(); // desktop and tablet: the ribbon's Table group
  return (
    <>
      <FormattingMenu editor={editor} />
      {isMobile && <TableMenu editor={editor} />}
      <ImageBar editor={editor} />
      {handle && <BlockHandle editor={editor} />}
    </>
  );
}

/** Page-wide popups shared by every editor on the page: slash menu, [[page link]] menu, link editor. */
export function EditorMenus() {
  return (
    <>
      <SlashMenuView />
      <PageLinkMenuView />
      <LinkEditorView />
    </>
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

/** Blocks the hover ✓ can turn into tasks. */
const TASKABLE = new Set(['paragraph', 'heading', 'listItem', 'bulletList', 'orderedList', 'taskList']);
const LIST_ITEMS = new Set(['listItem', 'taskItem']);
/** A list line's bullet or number sits in front of its own box: the grip keeps this far (px) clear of the line's text. */
const LIST_MARKER_GAP = 26;
/** Any other block: the grip ends this far (px) before its text. */
const BLOCK_GAP = 4;

/**
 * A slim grip (⋮⋮, ~20px) left of the line you point at, in the page's existing left gutter (it fits even for a box at x=0, without
 * covering text, a list marker or the sidebar): drag to move; click for a small menu (turn into a task, add a line below, delete the
 * line). In a list the grip belongs to the line you point at (not the whole list): dragging it moves that line with its sub-points,
 * and it can be dropped at any level to move the branch up or down the outline ("nested" handles: the library picks the line, not
 * the list around it).
 */
function BlockHandle({ editor }: { editor: Editor }) {
  const current = useRef<{ pos: number; size: number } | null>(null);
  const [taskable, setTaskable] = useState(false);
  const [menu, setMenu] = useState<{ pos: number; size: number; taskable: boolean } | null>(null);
  const grip = useRef<HTMLSpanElement>(null);
  // Nested lists: the line under the pointer's row is the target, and the grip waits for the pointer to reach it (handleReach.ts).
  useEffect(() => {
    if (editor.isDestroyed || !editor.view?.dom) return;
    return installHandleReach(editor.view.dom);
  }, [editor]);

  const turnIntoTask = (c: { pos: number; size: number }) => {
    const { doc } = editor.state;
    // A text block: put the cursor in it. A list: select all of it (each item becomes a task).
    const node = doc.nodeAt(c.pos);
    // A list line: just that line's text (not the points nested under it).
    const sel =
      node?.isTextblock || (node && LIST_ITEMS.has(node.type.name))
        ? TextSelection.near(doc.resolve(c.pos + (node.isTextblock ? 1 : 2)))
        : TextSelection.between(doc.resolve(c.pos + 1), doc.resolve(c.pos + c.size - 1));
    editor.chain().focus().setTextSelection({ from: sel.from, to: sel.to }).run();
    if (canConvert(editor)) convertToTasks(editor);
  };
  const addLineBelow = (c: { pos: number; size: number }) => {
    const at = c.pos + c.size;
    // Below a list line: a new line of that list (a paragraph can't sit between list items).
    const node = editor.state.doc.nodeAt(c.pos);
    const item = node && LIST_ITEMS.has(node.type.name) ? node.type.name : null;
    editor
      .chain()
      .insertContentAt(at, item ? { type: item, ...(item === 'taskItem' ? { attrs: { checked: false } } : {}), content: [{ type: 'paragraph' }] } : { type: 'paragraph' })
      .command(({ tr }) => {
        tr.setSelection(TextSelection.create(tr.doc, at + (item ? 2 : 1)));
        return true;
      })
      .focus()
      .run();
  };
  const deleteLine = (c: { pos: number; size: number }) => {
    editor.chain().focus().deleteRange({ from: c.pos, to: c.pos + c.size }).run();
  };

  return (
    <>
      <DragHandle
        editor={editor}
        className="block-handle"
        nested
        getReferencedVirtualElement={() => {
          const c = current.current;
          const node = c ? editor.state.doc.nodeAt(c.pos) : null;
          const dom = c && node ? (editor.view.nodeDOM(c.pos) as HTMLElement | null) : null;
          if (!c || !node || !dom) return null;
          // The grip's place always comes from the CURRENT target's own left edge, recomputed at every retarget (up to a parent or a
          // heading too): a list line keeps clear of its bullet or number, any other block gets a small gap.
          // A task with notes has its fold arrow in that margin: the grip goes left of it.
          const gap = LIST_ITEMS.has(node.type.name) ? LIST_MARKER_GAP : node.type.name === 'taskRef' && node.childCount ? BLOCK_GAP + 24 : BLOCK_GAP;
          return { getBoundingClientRect: () => { const r = dom.getBoundingClientRect(); return DOMRect.fromRect({ x: r.x - gap, y: r.y, width: r.width, height: r.height }); } };
        }}
        onNodeChange={({ node, pos }) => {
          current.current = node ? { pos, size: node.nodeSize } : null;
          setTaskable(!!node && TASKABLE.has(node.type.name) && node.textContent.trim() !== '');
        }}
      >
        <span
          ref={grip}
          role="button"
          className="block-handle-grip"
          title="Drag to move · click for more (or Alt+Shift+↑/↓)"
          aria-label="Block options"
          data-drag-handle
          onClick={() => {
            // A click (no drag) opens the menu for the line the grip is on.
            const c = current.current;
            if (c) setMenu({ ...c, taskable });
          }}
        >
          <GripVertical size={15} />
        </span>
      </DragHandle>
      <Popover anchor={grip} open={!!menu} onClose={() => setMenu(null)} placement="bottom-start">
        {menu && (
          <div className="menu" role="menu" aria-label="Block options">
            {menu.taskable && (
              <MenuItem
                icon={<CircleCheck size={15} />}
                hint={keyLabel(MOD, ENTER)}
                onSelect={() => {
                  setMenu(null);
                  turnIntoTask(menu);
                }}
              >
                Turn into task
              </MenuItem>
            )}
            <MenuItem
              icon={<Plus size={15} />}
              onSelect={() => {
                setMenu(null);
                addLineBelow(menu);
              }}
            >
              Add line below
            </MenuItem>
            <MenuItem
              icon={<Trash2 size={15} />}
              danger
              onSelect={() => {
                setMenu(null);
                deleteLine(menu);
              }}
            >
              Delete line
            </MenuItem>
          </div>
        )}
      </Popover>
    </>
  );
}

/**
 * Where the floating toolbar is rendered: a host of its own in the page scroller, so it is never
 * inside a canvas box (the canvas surface is its own stacking layer, under the ribbon) and it
 * scrolls with the page. Its own host keeps TipTap's "focus moved into the menu" check narrow.
 */
function useFloatHost(editor: Editor) {
  const host = useRef<HTMLDivElement | null>(null);
  useEffect(
    () => () => {
      const el = host.current;
      host.current = null;
      requestAnimationFrame(() => el?.remove()); // after the BubbleMenu has taken its element out
    },
    [editor],
  );
  return useCallback(() => {
    if (!host.current) {
      host.current = document.createElement('div');
      host.current.className = 'float-host';
    }
    const parent = (!editor.isDestroyed && editor.view.dom.closest('.page-scroll')) || document.body;
    if (host.current.parentElement !== parent) parent.appendChild(host.current);
    return host.current;
  }, [editor]);
}

/** Space the floating toolbar keeps clear at the top of the scroller: the top bar and the ribbon. */
const FLOATING_OPTIONS = {
  flip: ({ elements }: { elements: { floating: HTMLElement } }) => {
    const scroller = elements.floating.closest('.page-scroll');
    const bottoms = scroller ? [...scroller.querySelectorAll(':scope > .page-topbar, :scope > .ribbon')].map((el) => el.getBoundingClientRect().bottom) : [];
    const top = scroller && bottoms.length ? Math.max(0, ...bottoms.map((b) => b - scroller.getBoundingClientRect().top)) : 0;
    return { padding: { top: top + 4 } };
  },
};

function FormattingMenu({ editor }: { editor: Editor }) {
  const appendTo = useFloatHost(editor);
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
    <button
      type="button"
      className={`bm-btn ${active ? 'is-active' : ''}`}
      title={title}
      aria-label={title}
      aria-pressed={active}
      tabIndex={-1}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {icon}
    </button>
  );
  return (
    <BubbleMenu
      editor={editor}
      className="bubble-menu"
      appendTo={appendTo}
      options={FLOATING_OPTIONS}
      shouldShow={({ editor: e, state }) => {
        const { empty } = state.selection;
        // Keep showing while keyboard focus is inside the toolbar itself.
        const inToolbar = !!document.activeElement?.closest('.bubble-menu');
        if (empty || e.isDestroyed || !e.isEditable || !(e.isFocused || inToolbar)) return false;
        if (state.selection instanceof TextSelection === false) return false; // node selections (images, files, tasks)
        return !e.isActive('codeBlock');
      }}
    >
      {/* BubbleMenu renders its own container; the toolbar semantics and keys live on this one. */}
      <div className="bubble-menu-bar" role="toolbar" aria-label="Formatting" aria-orientation="horizontal" onKeyDown={(e) => toolbarKeys(e, editor, 'button')}>
      {btn(s.h1, 'Heading 1', () => editor.chain().focus().toggleHeading({ level: 1 }).run(), <Heading1 size={16} />)}
      {btn(s.h2, 'Heading 2', () => editor.chain().focus().toggleHeading({ level: 2 }).run(), <Heading2 size={16} />)}
      {btn(s.h3, 'Heading 3', () => editor.chain().focus().toggleHeading({ level: 3 }).run(), <Heading3 size={16} />)}
      {btn(s.quote, 'Quote', () => editor.chain().focus().toggleBlockquote().run(), <Quote size={16} />)}
      <span className="bm-sep" />
      {btn(s.bold, `Bold (${keyLabel(MOD, 'B')})`, () => editor.chain().focus().toggleBold().run(), <Bold size={16} />)}
      {btn(s.italic, `Italic (${keyLabel(MOD, 'I')})`, () => editor.chain().focus().toggleItalic().run(), <Italic size={16} />)}
      {btn(s.underline, `Underline (${keyLabel(MOD, 'U')})`, () => editor.chain().focus().toggleUnderline().run(), <Underline size={16} />)}
      {btn(s.strike, `Strikethrough (${keyLabel(MOD, SHIFT, 'S')})`, () => editor.chain().focus().toggleStrike().run(), <Strikethrough size={16} />)}
      {btn(s.code, `Inline code (${keyLabel(MOD, 'E')})`, () => editor.chain().focus().toggleCode().run(), <Code size={16} />)}
      {btn(s.link, `Link (${keyLabel(MOD, 'K')})`, () => openLinkEditor(editor), <Link2 size={16} />)}
      {/* The same colour controls (and icons) as the ribbon. */}
      <ColorMenu editor={editor} kind="text" />
      <ColorMenu editor={editor} kind="highlight" />
      <span className="bm-sep" />
      <button
        type="button"
        className="bm-btn bm-text"
        title={`Turn into task (${keyLabel(MOD, ENTER)})`}
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => editor.chain().focus().convertToTask().run()}
      >
        <CircleCheck size={16} /> Task
      </button>
      <button type="button" className="bm-btn bm-text" title="Comment" onMouseDown={(e) => e.preventDefault()} onClick={() => beginComment(editor)}>
        <MessageSquare size={16} /> Comment
      </button>
      </div>
    </BubbleMenu>
  );
}

/** When an image is selected: edit its description (alt text) for screen readers. */
function ImageBar({ editor }: { editor: Editor }) {
  const image = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const sel = e.state.selection;
      return sel instanceof NodeSelection && sel.node.type.name === 'image' ? { pos: sel.from, alt: String(sel.node.attrs.alt ?? '') } : null;
    },
  });
  const [value, setValue] = useState('');
  useEffect(() => setValue(image?.alt ?? ''), [image?.pos, image?.alt]);
  if (!image) return null;
  const save = () => {
    if (value !== image.alt) editor.chain().setNodeSelection(image.pos).updateAttributes('image', { alt: value.trim() }).run();
  };
  return (
    <div className="table-bar image-bar" contentEditable={false}>
      <label className="image-alt">
        <span>Alt text</span>
        <input
          className="input"
          aria-label="Image description (alt text)"
          placeholder="Describe the image for people who can't see it"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              save();
              editor.commands.focus();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setValue(image.alt);
              editor.commands.focus();
            }
          }}
        />
      </label>
    </div>
  );
}

/**
 * Move focus into the formatting toolbar. It appears shortly after a selection is made,
 * and a hidden element can't take focus, so retry for a few frames until it's visible.
 */
function focusToolbar(attempt = 0) {
  const bar = document.querySelector<HTMLElement>('.bubble-menu [role="toolbar"]');
  const first = bar?.querySelector<HTMLButtonElement>('button');
  const visible = !!bar && bar.getBoundingClientRect().width > 0 && getComputedStyle(bar).visibility !== 'hidden';
  if (first && visible) first.focus();
  else if (attempt < 90) requestAnimationFrame(() => focusToolbar(attempt + 1)); // ~1.5 s for the bubble menu to show on a slow machine
}

/** The table that holds the selection: its outer element (the wrapper when columns are resizable). */
function tableElement(editor: Editor): HTMLElement | null {
  if (editor.isDestroyed) return null;
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name !== 'table') continue;
    const dom = editor.view.nodeDOM($from.before(d));
    return dom instanceof HTMLElement ? dom : null;
  }
  return null;
}

/** Above the table (below it when there is no room above): never over its cells. */
const TABLE_MENU_OPTIONS = { ...FLOATING_OPTIONS, placement: 'top-start' as const, offset: 6, shift: { padding: 8 } };

/**
 * Phones (no ribbon): the table's controls float above the table, outside it, as the
 * formatting toolbar does. Desktop and tablet have them in the ribbon's Table group instead.
 */
function TableMenu({ editor }: { editor: Editor }) {
  const appendTo = useFloatHost(editor);
  const b = (title: string, fn: () => void, icon: React.ReactNode, label = title) => (
    <button type="button" className="bm-btn bm-text" title={title} aria-label={title} onMouseDown={(e) => e.preventDefault()} onClick={fn}>
      {icon} {label}
    </button>
  );
  return (
    <BubbleMenu
      editor={editor}
      pluginKey="tableMenu"
      className="bubble-menu table-menu"
      appendTo={appendTo}
      options={TABLE_MENU_OPTIONS}
      getReferencedVirtualElement={() => {
        const el = tableElement(editor);
        return el && { getBoundingClientRect: () => el.getBoundingClientRect(), getClientRects: () => el.getClientRects(), contextElement: el };
      }}
      shouldShow={({ editor: e, state }) => {
        const inMenu = !!document.activeElement?.closest('.table-menu');
        if (e.isDestroyed || !e.isEditable || !(e.isFocused || inMenu) || !e.isActive('table')) return false;
        return state.selection.empty || !(state.selection instanceof TextSelection); // selected text: the formatting toolbar
      }}
    >
      <div className="bubble-menu-bar" role="toolbar" aria-label="Table" onKeyDown={(e) => toolbarKeys(e, editor, 'button')}>
        {b('Insert row below', () => editor.chain().focus().addRowAfter().run(), <ArrowDownToLine size={14} />, 'Row')}
        {b('Insert column right', () => editor.chain().focus().addColumnAfter().run(), <ArrowRightToLine size={14} />, 'Column')}
        {b('Header row', () => editor.chain().focus().toggleHeaderRow().run(), <PanelTop size={14} />, 'Header')}
        <span className="bm-sep" />
        {b('Delete row', () => editor.chain().focus().deleteRow().run(), <Rows3 size={14} />, 'Delete row')}
        {b('Delete column', () => editor.chain().focus().deleteColumn().run(), <Columns3 size={14} />, 'Delete column')}
        {b('Delete table', () => editor.chain().focus().deleteTable().run(), <Trash2 size={14} />, 'Delete table')}
      </div>
    </BubbleMenu>
  );
}
