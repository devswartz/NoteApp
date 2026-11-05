// [[Page links]]: an inline node pointing at another page by id. It renders the
// page's current title and icon from the tree, so renames show up everywhere.
// Type "[[" to pick a page (or create one); backlinks are listed under the page.
import { Node, mergeAttributes, type Editor, type Range } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react';
import Suggestion from '@tiptap/suggestion';
import { PluginKey } from '@tiptap/pm/state';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { create } from 'zustand';
import { FileText, Plus } from 'lucide-react';
import { post } from '../api.ts';
import { errorToast, useStore } from '../store.ts';
import { pageItems, type PageItem } from './pageItems.ts';

export type { PageItem };

export interface PageLinkOptions {
  /** The page being edited: excluded from suggestions, and where "Create" puts the new page. */
  pageId: string;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    pageLink: {
      insertPageLink: (pageId: string) => ReturnType;
    };
  }
}

const pageLinkKey = new PluginKey('pageLinkSuggestion');

export const PageLink = Node.create<PageLinkOptions>({
  name: 'pageLink',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addOptions() {
    return { pageId: '' };
  },
  addAttributes() {
    return {
      pageId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-page-id'),
        renderHTML: (a) => ({ 'data-page-id': a.pageId }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'a[data-type="page-link"]' }];
  },
  renderHTML({ HTMLAttributes, node }) {
    const page = useStore.getState().tree.pages.find((p) => p.id === node.attrs.pageId);
    return ['a', mergeAttributes(HTMLAttributes, { 'data-type': 'page-link', class: 'page-link' }), page?.title || 'Untitled'];
  },
  renderText({ node }) {
    const page = useStore.getState().tree.pages.find((p) => p.id === node.attrs.pageId);
    return `[[${page?.title || 'Untitled'}]]`;
  },
  addNodeView() {
    return ReactNodeViewRenderer(PageLinkView, { as: 'span' });
  },
  addCommands() {
    return {
      insertPageLink:
        (pageId) =>
        ({ commands }) =>
          commands.insertContent([{ type: this.name, attrs: { pageId } }, { type: 'text', text: ' ' }]),
    };
  },
  addProseMirrorPlugins() {
    const self = this;
    return [
      Suggestion<PageItem>({
        editor: this.editor,
        pluginKey: pageLinkKey,
        char: '[[',
        allowSpaces: true,
        allowedPrefixes: null,
        allow: ({ state, range }) => !state.doc.resolve(range.from).parent.type.spec.code,
        items: ({ query }) => pageItems(query, self.options.pageId, useStore.getState().tree),
        command: ({ editor, range, props }) => void pickPage(editor, range, props, self.options.pageId),
        render: () => ({
          onStart: (p) => useMenu.setState({ open: true, items: p.items, index: 0, rect: p.clientRect?.() ?? null, pick: (i) => p.command(i) }),
          onUpdate: (p) => useMenu.setState({ items: p.items, index: 0, rect: p.clientRect?.() ?? null, pick: (i) => p.command(i) }),
          onExit: () => useMenu.setState({ open: false, items: [], pick: null }),
          onKeyDown: ({ event }) => {
            const s = useMenu.getState();
            if (!s.open) return false;
            const n = Math.max(1, s.items.length);
            if (event.key === 'ArrowDown') return useMenu.setState({ index: (s.index + 1) % n }), true;
            if (event.key === 'ArrowUp') return useMenu.setState({ index: (s.index - 1 + n) % n }), true;
            if (event.key === 'Enter' || event.key === 'Tab') {
              const item = s.items[s.index];
              if (item && s.pick) s.pick(item);
              return !!item;
            }
            if (event.key === 'Escape') return useMenu.setState({ open: false }), true;
            return false;
          },
        }),
      }),
    ];
  },
});

// ───────────── Suggestions ─────────────

async function pickPage(editor: Editor, range: Range, item: PageItem, currentPageId: string) {
  if (item.kind === 'page') {
    editor.chain().focus().deleteRange(range).insertPageLink(item.page.id).run();
    return;
  }
  // Create a sibling page with that title, then link to it.
  const sectionId = useStore.getState().tree.pages.find((p) => p.id === currentPageId)?.sectionId;
  if (!sectionId) return;
  editor.chain().focus().deleteRange(range).run();
  const at = editor.state.selection.from;
  try {
    const { id } = await post<{ id: string }>(`/sections/${sectionId}/pages`, { title: item.title });
    const now = new Date().toISOString();
    // Show it right away; the tree event refreshes the real row.
    useStore.setState((s) =>
      s.tree.pages.some((p) => p.id === id)
        ? s
        : { tree: { ...s.tree, pages: [...s.tree.pages, { id, sectionId, title: item.title, icon: null, kind: 'document', position: Infinity, updatedAt: now, updatedBy: null }] } },
    );
    if (!editor.isDestroyed) editor.chain().focus().setTextSelection(Math.min(at, editor.state.doc.content.size)).insertPageLink(id).run();
  } catch (e) {
    errorToast(e);
  }
}

interface MenuState {
  open: boolean;
  items: PageItem[];
  index: number;
  rect: DOMRect | null;
  pick: ((item: PageItem) => void) | null;
}
const useMenu = create<MenuState>(() => ({ open: false, items: [], index: 0, rect: null, pick: null }));

export function PageLinkMenuView() {
  const { open, items, index, rect, pick } = useMenu();
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [index]);
  if (!open || !rect) return null;
  const top = rect.bottom + 6 + 300 > window.innerHeight ? Math.max(8, rect.top - 306) : rect.bottom + 6;
  const left = Math.min(rect.left, window.innerWidth - 320);
  return createPortal(
    <div className="popover slash-menu page-link-menu" style={{ top, left }} ref={listRef} onMouseDown={(e) => e.preventDefault()}>
      <div className="menu-label-row">Link to page</div>
      {!items.length && <div className="muted small page-link-empty">Type a page title…</div>}
      {items.map((item, i) => (
        <button
          key={item.kind === 'page' ? item.page.id : 'create'}
          className={`slash-item page-link-item ${i === index ? 'is-active' : ''}`}
          onMouseEnter={() => useMenu.setState({ index: i })}
          onClick={() => pick?.(item)}
        >
          <span className="page-link-item-icon">
            {item.kind === 'create' ? <Plus size={15} /> : item.page.icon ? item.page.icon : <FileText size={15} />}
          </span>
          <span className="page-link-item-text">
            <span className="slash-title truncate">{item.kind === 'create' ? `Create “${item.title}”` : item.page.title || 'Untitled'}</span>
            {item.kind === 'page' && <span className="slash-desc truncate">{item.crumb}</span>}
          </span>
        </button>
      ))}
    </div>,
    document.body,
  );
}

// ───────────── Node view ─────────────

function PageLinkView({ node, selected }: ReactNodeViewProps) {
  const id = node.attrs.pageId as string;
  const page = useStore((s) => s.tree.pages.find((p) => p.id === id));
  const wsId = useStore((s) => s.wsId);
  const loaded = useStore((s) => s.treeLoaded);
  return (
    <NodeViewWrapper as="span" className={`page-link ${selected ? 'is-selected' : ''} ${page ? '' : 'is-missing'}`} data-page-id={id}>
      {page ? (
        <Link to={`/w/${wsId}/p/${id}`} contentEditable={false} draggable={false}>
          <span className="page-link-icon">{page.icon || <FileText size={14} />}</span>
          <span className="page-link-title">{page.title || 'Untitled'}</span>
        </Link>
      ) : (
        <span contentEditable={false} title="This page was deleted or you don't have access">
          <span className="page-link-icon">
            <FileText size={14} />
          </span>
          <span className="page-link-title">{loaded ? 'Page unavailable' : '…'}</span>
        </span>
      )}
    </NodeViewWrapper>
  );
}
