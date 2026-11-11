// "/" command menu for inserting blocks.
import { Extension, type Editor, type Range } from '@tiptap/core';
import Suggestion from '@tiptap/suggestion';
import { PluginKey } from '@tiptap/pm/state';
import { create } from 'zustand';
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MOD, keyLabel } from '../components/ui.tsx';
import {
  ChevronRight,
  FileSymlink,
  Link2,
  MessageSquareQuote,
  CheckSquare,
  CircleCheck,
  Code2,
  Heading1,
  Heading2,
  Heading3,
  Image,
  List,
  ListOrdered,
  Minus,
  Paperclip,
  Quote,
  Table,
  Type,
} from 'lucide-react';

export interface SlashItem {
  title: string;
  description: string;
  keywords: string;
  icon: ReactNode;
  run: (editor: Editor, range: Range) => void;
}

/** Bridges the editor to file pickers in the React tree. */
export const slashHooks = {
  pickImage: (_editor: Editor) => {},
  pickFile: (_editor: Editor) => {},
  editLink: (_editor: Editor): boolean => false,
};

export const SLASH_ITEMS: SlashItem[] = [
  {
    title: 'Task',
    description: 'A real task, synced to your dashboard',
    keywords: 'todo task action checkbox assign',
    icon: <CircleCheck size={18} />,
    run: (e, r) => e.chain().focus().deleteRange(r).insertTask().run(),
  },
  {
    title: 'Text',
    description: 'Plain paragraph',
    keywords: 'paragraph p',
    icon: <Type size={18} />,
    run: (e, r) => e.chain().focus().deleteRange(r).setParagraph().run(),
  },
  {
    title: 'Heading 1',
    description: 'Large section heading',
    keywords: 'h1 title',
    icon: <Heading1 size={18} />,
    run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 1 }).run(),
  },
  {
    title: 'Heading 2',
    description: 'Medium section heading',
    keywords: 'h2 subtitle',
    icon: <Heading2 size={18} />,
    run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 2 }).run(),
  },
  {
    title: 'Heading 3',
    description: 'Small section heading',
    keywords: 'h3',
    icon: <Heading3 size={18} />,
    run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 3 }).run(),
  },
  {
    title: 'Checklist',
    description: 'Simple checkboxes (not tracked as tasks)',
    keywords: 'checkbox list todo plain',
    icon: <CheckSquare size={18} />,
    run: (e, r) => e.chain().focus().deleteRange(r).toggleTaskList().run(),
  },
  {
    title: 'Bulleted list',
    description: 'Simple bulleted list',
    keywords: 'ul unordered bullet',
    icon: <List size={18} />,
    run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run(),
  },
  {
    title: 'Numbered list',
    description: 'List with numbering',
    keywords: 'ol ordered number',
    icon: <ListOrdered size={18} />,
    run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run(),
  },
  {
    title: 'Toggle',
    description: 'Collapsible section with hidden content',
    keywords: 'toggle collapse collapsible details expand fold',
    icon: <ChevronRight size={18} />,
    run: (e, r) => {
      e.chain().focus().deleteRange(r).setDetails().run();
      // A new toggle opens, so Enter after its title goes into its content.
      requestAnimationFrame(() => {
        const at = e.view.domAtPos(e.state.selection.from).node;
        const el = (at instanceof HTMLElement ? at : at.parentElement)?.closest('.toggle');
        const button = el?.querySelector<HTMLButtonElement>(':scope > button');
        if (el && button && !el.classList.contains('is-open')) {
          button.click();
          e.commands.focus();
        }
      });
    },
  },
  {
    title: 'Table',
    description: 'Rows and columns',
    keywords: 'grid spreadsheet',
    icon: <Table size={18} />,
    run: (e, r) => e.chain().focus().deleteRange(r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  {
    title: 'Image',
    description: 'Upload an image',
    keywords: 'picture photo upload',
    icon: <Image size={18} />,
    run: (e, r) => {
      e.chain().focus().deleteRange(r).run();
      slashHooks.pickImage(e);
    },
  },
  {
    title: 'File attachment',
    description: 'Upload any file',
    keywords: 'attachment upload pdf document',
    icon: <Paperclip size={18} />,
    run: (e, r) => {
      e.chain().focus().deleteRange(r).run();
      slashHooks.pickFile(e);
    },
  },
  {
    title: 'Link',
    description: `Link to a web page (or select text and press ${keyLabel(MOD, 'K')})`,
    keywords: 'url href hyperlink web',
    icon: <Link2 size={18} />,
    run: (e, r) => {
      e.chain().focus().deleteRange(r).run();
      slashHooks.editLink(e);
    },
  },
  {
    title: 'Link to page',
    description: 'Link another page (or type [[)',
    keywords: 'page link reference backlink wiki [[',
    icon: <FileSymlink size={18} />,
    run: (e, r) => e.chain().focus().deleteRange(r).insertContent('[[').run(),
  },
  {
    title: 'Quote',
    description: 'Capture a quotation',
    keywords: 'blockquote citation',
    icon: <Quote size={18} />,
    run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run(),
  },
  {
    title: 'Callout',
    description: 'Highlighted note with an icon',
    keywords: 'callout info note tip warning admonition box',
    icon: <MessageSquareQuote size={18} />,
    run: (e, r) => e.chain().focus().deleteRange(r).setCallout().run(),
  },
  {
    title: 'Code block',
    description: 'Code with syntax highlighting',
    keywords: 'pre snippet code ``` program',
    icon: <Code2 size={18} />,
    run: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run(),
  },
  {
    title: 'Divider',
    description: 'Horizontal line',
    keywords: 'hr separator rule',
    icon: <Minus size={18} />,
    run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run(),
  },
];

interface SlashState {
  open: boolean;
  items: SlashItem[];
  index: number;
  rect: DOMRect | null;
  pick: ((item: SlashItem) => void) | null;
}
const useSlash = create<SlashState>(() => ({ open: false, items: [], index: 0, rect: null, pick: null }));

/** Title prefix matches first, then word-prefix matches in title or keywords, then substring matches. */
export function filterSlash(query: string, items: SlashItem[] = SLASH_ITEMS): SlashItem[] {
  const q = query.toLowerCase().trim();
  if (!q) return items;
  const score = (i: SlashItem) => {
    const t = i.title.toLowerCase();
    const words = `${t} ${i.keywords.toLowerCase()}`.split(/\s+/);
    if (t.startsWith(q)) return 0;
    if (words.some((w) => w.startsWith(q))) return 1;
    if (t.includes(q) || i.keywords.toLowerCase().includes(q)) return 2;
    return -1;
  };
  return items
    .map((i, n) => ({ i, n, s: score(i) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s || a.n - b.n)
    .map((x) => x.i);
}

export const SlashCommand = Extension.create({
  name: 'slashCommand',
  addProseMirrorPlugins() {
    return [
      Suggestion<SlashItem>({
        editor: this.editor,
        pluginKey: new PluginKey('slash'),
        char: '/',
        startOfLine: false,
        allowSpaces: false,
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          return $from.parent.type.name !== 'codeBlock' && !$from.parent.type.spec.code;
        },
        items: ({ query }) => filterSlash(query),
        command: ({ editor, range, props }) => props.run(editor, range),
        render: () => ({
          onStart: (p) =>
            useSlash.setState({ open: true, items: p.items, index: 0, rect: p.clientRect?.() ?? null, pick: (i) => p.command(i) }),
          onUpdate: (p) =>
            useSlash.setState({ items: p.items, index: 0, rect: p.clientRect?.() ?? null, pick: (i) => p.command(i) }),
          onExit: () => useSlash.setState({ open: false, items: [], pick: null }),
          onKeyDown: ({ event }) => {
            const s = useSlash.getState();
            if (!s.open) return false;
            if (event.key === 'ArrowDown') {
              useSlash.setState({ index: (s.index + 1) % Math.max(1, s.items.length) });
              return true;
            }
            if (event.key === 'ArrowUp') {
              useSlash.setState({ index: (s.index - 1 + s.items.length) % Math.max(1, s.items.length) });
              return true;
            }
            if (event.key === 'Enter' || event.key === 'Tab') {
              const item = s.items[s.index];
              if (item && s.pick) s.pick(item);
              return !!item;
            }
            if (event.key === 'Escape') {
              useSlash.setState({ open: false });
              return true;
            }
            return false;
          },
        }),
      }),
    ];
  },
});

export function SlashMenuView() {
  const { open, items, index, rect, pick } = useSlash();
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [index]);
  if (!open || !rect || !items.length) return null;
  const top = rect.bottom + 6 + 320 > window.innerHeight ? Math.max(8, rect.top - 326) : rect.bottom + 6;
  const left = Math.min(rect.left, window.innerWidth - 300);
  return createPortal(
    <div
      className="popover slash-menu"
      style={{ top, left }}
      ref={listRef}
      onMouseDown={(e) => e.preventDefault()}
      role="listbox"
      aria-label="Insert block"
      id="slash-menu"
    >
      <div className="menu-label-row" aria-hidden="true">
        Insert block
      </div>
      {items.map((item, i) => (
        <button
          key={item.title}
          id={`slash-item-${i}`}
          role="option"
          aria-selected={i === index}
          tabIndex={-1}
          className={`slash-item ${i === index ? 'is-active' : ''}`}
          onMouseEnter={() => useSlash.setState({ index: i })}
          onClick={() => pick?.(item)}
        >
          <span className="slash-icon" aria-hidden="true">
            {item.icon}
          </span>
          <span>
            <span className="slash-title">{item.title}</span>
            <span className="slash-desc">{item.description}</span>
          </span>
        </button>
      ))}
    </div>,
    document.body,
  );
}
