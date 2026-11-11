// The ribbon: a OneNote-style bar across the full width of the window, above the rail, the
// panels and the note (desktop and tablet; AppShell renders it). Its editing controls act on
// the page's active editor (./activeEditor.ts), its Page group on the open page's settings
// (./ribbonState.ts). Also the colour menus it shares with the floating toolbar over selected
// text (NoteEditor.tsx).
// WAI-ARIA toolbar pattern: one tab stop (roving tabindex), ←/→/Home/End move between
// controls, Escape returns to the text. Alt+F10 in the text and F6 focus it.
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useEditorState, type Editor } from '@tiptap/react';
import {
  Baseline,
  Bold,
  ChevronDown,
  ChevronUp,
  CircleCheck,
  FileSymlink,
  Grid3x3,
  Highlighter,
  ImagePlus,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  ListTree,
  MessageSquare,
  Minus,
  PaintBucket,
  PanelLeft,
  Paperclip,
  Redo2,
  RemoveFormatting,
  Rows3,
  Strikethrough,
  Table,
  Underline,
  Undo2,
} from 'lucide-react';
import { canConvert } from './TaskRef.tsx';
import { useActiveEditor } from './activeEditor.ts';
import { openLinkEditor } from './LinkEditor.tsx';
import { slashHooks } from './SlashMenu.tsx';
import { applyColor, COLOR_LABELS, COLOR_NAMES, currentColor, type ColorKind, type ColorName } from './colors.ts';
import { setOutlineHidden, setRibbonCollapsed, syncRibbonPrefs, usePageSettings, useRibbon } from './ribbonState.ts';
import { PAGE_COLORS, RULE_LINES, setPageSettings, type PageColor, type RuleLines } from '../../shared/pageDoc.ts';
import { ENTER, MOD, SHIFT, keyLabel } from '../components/ui.tsx';
import { ui, useStore } from '../store.ts';
import { setPagePanel, usePagePanel } from '../store/ui.ts';
import '../styles/colors.css';
import '../styles/toolbar.css';

const BLOCKS = [
  { id: 'p', label: 'Normal' },
  { id: 'h1', label: 'Heading 1' },
  { id: 'h2', label: 'Heading 2' },
  { id: 'h3', label: 'Heading 3' },
  { id: 'quote', label: 'Quote' },
  { id: 'code', label: 'Code' },
] as const;
type BlockId = (typeof BLOCKS)[number]['id'];

export const PAGE_COLOR_LABELS: Record<PageColor, string> = {
  none: 'No colour',
  yellow: 'Yellow',
  green: 'Green',
  blue: 'Blue',
  purple: 'Purple',
  pink: 'Pink',
  grey: 'Grey',
};
const RULE_LABELS: Record<RuleLines, string> = { none: 'None', lines: 'Lines', grid: 'Grid' };

/** Items of a toolbar that take part in its arrow-key navigation (not the buttons inside an open menu). */
const ITEM = '[data-tb-item]';

/** Roving tabindex for a toolbar element: exactly one item is tabbable, and it follows focus. */
function useRovingTabIndex(ref: React.RefObject<HTMLElement | null>) {
  const current = useRef(0);
  useLayoutEffect(() => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>(ITEM) ?? [])];
    if (current.current >= items.length) current.current = 0;
    items.forEach((el, i) => (el.tabIndex = i === current.current ? 0 : -1));
  });
  return {
    onFocus: (e: React.FocusEvent<HTMLElement>) => {
      const items = [...(ref.current?.querySelectorAll<HTMLElement>(ITEM) ?? [])];
      const i = items.indexOf(e.target as HTMLElement);
      if (i < 0) return;
      current.current = i;
      items.forEach((el, j) => (el.tabIndex = j === i ? 0 : -1));
    },
  };
}

/** ←/→, Home/End between toolbar items; Escape back to the text. */
export function toolbarKeys(e: React.KeyboardEvent<HTMLElement>, editor: Editor | null, selector = ITEM) {
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>(selector)].filter((b) => !b.closest('.tb-pop'));
  const i = items.indexOf(document.activeElement as HTMLElement);
  if (i < 0) return;
  const go = (n: number) => {
    e.preventDefault();
    items[(n + items.length) % items.length].focus();
  };
  if (e.key === 'ArrowRight') go(i + 1);
  else if (e.key === 'ArrowLeft') go(i - 1);
  else if (e.key === 'Home') go(0);
  else if (e.key === 'End') go(items.length - 1);
  else if (e.key === 'Escape' && editor && !editor.isDestroyed) {
    e.preventDefault();
    editor.commands.focus();
  }
}

/**
 * A toolbar button that opens a small menu below it. The menu lives inside the toolbar's
 * DOM (not a portal), so the floating toolbar stays open while it's in use, and every
 * press keeps the editor's selection (mousedown is prevented).
 */
export function ToolbarMenu({
  label,
  trigger,
  className = '',
  disabled = false,
  children,
}: {
  label: string;
  trigger: ReactNode;
  className?: string;
  disabled?: boolean;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onDown);
    // Focus the selected choice (or the first) so the menu works from the keyboard.
    const pop = wrap.current?.querySelector('.tb-pop');
    pop?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.focus() ?? pop?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  return (
    <span className="tb-menu" ref={wrap}>
      <button
        ref={button}
        type="button"
        data-tb-item
        className={`bm-btn tb-menu-btn ${className}`}
        title={label}
        aria-label={label}
        aria-haspopup="true"
        aria-expanded={open}
        aria-disabled={disabled || undefined}
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => !disabled && setOpen((o) => !o)}
      >
        {trigger}
      </button>
      {open && !disabled && (
        <div
          className="tb-pop"
          role="group"
          aria-label={label}
          onMouseDown={(e) => e.preventDefault()}
          onKeyDown={(e) => {
            const btns = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
            const i = btns.indexOf(document.activeElement as HTMLButtonElement);
            const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
            e.stopPropagation(); // the toolbar's own arrow keys don't apply inside the menu
            if (step && i >= 0) {
              e.preventDefault();
              btns[(i + step + btns.length) % btns.length].focus();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              close();
            } else if (e.key === 'Tab') setOpen(false);
          }}
        >
          {children(close)}
        </div>
      )}
    </span>
  );
}

/** Default + the palette, for text colour or highlight. */
export function ColorChoices({ editor, kind, done }: { editor: Editor; kind: ColorKind; done: () => void }) {
  const active = currentColor(editor, kind);
  const pick = (name: ColorName | null) => {
    applyColor(editor, kind, name);
    done();
    editor.commands.focus();
  };
  const swatch = (name: ColorName | null) => {
    const label = name ? COLOR_LABELS[name] : 'Default';
    return (
      <button
        key={name ?? 'default'}
        type="button"
        className={`color-choice ${kind === 'text' ? 'color-swatch' : 'hl-swatch'}`}
        data-color={name ?? undefined}
        title={label}
        aria-label={`${kind === 'text' ? 'Text colour' : 'Highlight'}: ${label}`}
        aria-pressed={active === name}
        onClick={() => pick(name)}
      >
        {kind === 'highlight' && !name ? <span className="hl-none" aria-hidden /> : 'A'}
      </button>
    );
  };
  return (
    <div className="color-choices">
      <div className="color-choices-label">{kind === 'text' ? 'Text colour' : 'Highlight'}</div>
      <div className="color-grid">{[null, ...COLOR_NAMES].map(swatch)}</div>
    </div>
  );
}

/** Text colour / highlight menu buttons; the trigger shows the colour at the selection. */
export function ColorMenu({ editor, kind }: { editor: Editor | null; kind: ColorKind }) {
  const color = useEditorState({ editor, selector: ({ editor: e }) => (e && !e.isDestroyed ? currentColor(e, kind) : null) });
  const label = kind === 'text' ? 'Text colour' : 'Highlight';
  return (
    <ToolbarMenu
      label={label}
      disabled={!editor}
      trigger={
        <>
          {kind === 'text' ? <Baseline size={16} /> : <Highlighter size={16} />}
          <span className={`tb-color-bar ${kind === 'text' ? 'is-text' : 'is-hl'}`} data-color={color ?? undefined} aria-hidden />
        </>
      }
    >
      {(close) => editor && <ColorChoices editor={editor} kind={kind} done={close} />}
    </ToolbarMenu>
  );
}

/** What the ribbon shows for the active editor's selection. */
function ribbonState(e: Editor) {
  const block: BlockId = e.isActive('codeBlock')
    ? 'code'
    : e.isActive('heading', { level: 1 })
      ? 'h1'
      : e.isActive('heading', { level: 2 })
        ? 'h2'
        : e.isActive('heading', { level: 3 })
          ? 'h3'
          : e.isActive('blockquote')
            ? 'quote'
            : 'p';
  return {
    block,
    bold: e.isActive('bold'),
    italic: e.isActive('italic'),
    underline: e.isActive('underline'),
    strike: e.isActive('strike'),
    bullet: e.isActive('bulletList'),
    ordered: e.isActive('orderedList'),
    check: e.isActive('taskList'),
    link: e.isActive('link'),
    canTask: canConvert(e),
    canUndo: e.can().undo(),
    canRedo: e.can().redo(),
  };
}

/** Set the block type at the selection (Normal also takes it out of a quote). */
function setBlock(editor: Editor, id: BlockId) {
  const chain = editor.chain().focus();
  if (id === 'code') {
    if (!editor.isActive('codeBlock')) chain.toggleCodeBlock().run();
    return;
  }
  if (id === 'quote') {
    if (!editor.isActive('blockquote')) chain.setParagraph().toggleBlockquote().run();
    return;
  }
  if (editor.isActive('blockquote')) chain.lift('blockquote');
  if (id === 'p') chain.setParagraph().run();
  else chain.setHeading({ level: Number(id.slice(1)) as 1 | 2 | 3 }).run();
}

/** Link: edits the link at the selection; with nothing selected, inserts "link" and edits that (as the slash menu does). */
function insertLink(editor: Editor) {
  if (editor.state.selection.empty && !editor.isActive('link')) {
    const from = editor.state.selection.from;
    const label = 'link';
    editor.chain().focus().insertContent(label).setTextSelection({ from, to: from + label.length }).run();
  }
  openLinkEditor(editor);
}

const Sep = () => <span className="bm-sep rb-sep" aria-hidden />;

/** A ribbon group with its small OneNote-style label underneath (hidden on narrow windows; it still names the group). */
function Group({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  const id = useId();
  return (
    <div className={`rb-group ${className}`} role="group" aria-labelledby={id}>
      <div className="rb-items">{children}</div>
      <span id={id} className="rb-label">
        {label}
      </span>
    </div>
  );
}

interface BtnOpts {
  active?: boolean;
  disabled?: boolean;
  /** A visible text label next to the icon (dropped on narrow windows); it is also the button's name. */
  text?: string;
}

/**
 * The ribbon (OneNote's Home tab, one tab only). Editing controls act on the active editor,
 * the one last focused on the open page; with none (no page open, an empty canvas, a viewer)
 * they are disabled, not hidden. The Page group needs a page you may edit; View and the
 * collapse chevron always work. Presses keep the editor's selection (mousedown is prevented).
 * Collapsed, it is a thin strip that restores on click (remembered on this device).
 */
export function Ribbon() {
  const active = useActiveEditor();
  const editor = active && !active.isDestroyed && active.isEditable ? active : null;
  const ref = useRef<HTMLDivElement>(null);
  const roving = useRovingTabIndex(ref);
  const s = useEditorState({ editor, selector: ({ editor: e }) => (e && !e.isDestroyed ? ribbonState(e) : null) });
  const page = useRibbon((r) => r.page);
  const collapsed = useRibbon((r) => r.collapsed);
  const outlineHidden = useRibbon((r) => r.outlineHidden);
  const sidebarOpen = useStore((st) => st.sidebarOpen);
  const panel = usePagePanel((p) => p.panel);
  const settings = usePageSettings(page?.doc);
  useEffect(syncRibbonPrefs, []); // the shell's storage is ready now (see store/ui.ts)
  const off = !editor || !s;
  const pageOff = !page || !page.canEdit;
  const chain = () => editor!.chain().focus();
  const button = (title: string, icon: ReactNode, run: () => void, opts: BtnOpts & { always?: boolean } = {}) => {
    const disabled = (!opts.always && off) || !!opts.disabled;
    const on = !disabled && !!opts.active;
    return (
      <button
        type="button"
        data-tb-item
        className={`bm-btn rb-btn ${on ? 'is-active' : ''} ${opts.text ? 'rb-text' : ''}`}
        title={title}
        aria-label={opts.text ?? title}
        aria-pressed={opts.active === undefined ? undefined : on}
        aria-disabled={disabled || undefined}
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => !disabled && run()}
      >
        {icon}
        {opts.text && <span className="rb-btn-label">{opts.text}</span>}
      </button>
    );
  };
  const btn = (title: string, icon: ReactNode, run: () => void, opts: BtnOpts = {}) => button(title, icon, run, opts);
  const viewBtn = (title: string, icon: ReactNode, run: () => void, opts: BtnOpts = {}) => button(title, icon, run, { ...opts, always: true });

  if (collapsed)
    return (
      <div
        ref={ref}
        className="ribbon is-collapsed"
        role="toolbar"
        aria-label="Ribbon"
        aria-orientation="horizontal"
        onFocus={roving.onFocus}
        onKeyDown={(e) => toolbarKeys(e, editor)}
        onClick={(e) => e.target === e.currentTarget && setRibbonCollapsed(false)}
      >
        <button
          type="button"
          data-tb-item
          className="bm-btn rb-expand"
          title="Show the ribbon"
          aria-label="Show the ribbon"
          aria-expanded={false}
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setRibbonCollapsed(false)}
        >
          <ChevronDown size={14} />
        </button>
      </div>
    );

  const block = s?.block ?? 'p';
  const blockLabel = BLOCKS.find((b) => b.id === block)!.label;
  return (
    <div
      ref={ref}
      className={`ribbon ${off ? 'is-idle' : ''}`}
      role="toolbar"
      aria-label="Ribbon"
      aria-orientation="horizontal"
      onFocus={roving.onFocus}
      onKeyDown={(e) => toolbarKeys(e, editor)}
    >
      <Group label="Text">
        <ToolbarMenu
          label={`Block type: ${blockLabel}`}
          className="tb-block"
          disabled={off}
          trigger={
            <>
              <span className="tb-block-label">{blockLabel}</span>
              <ChevronDown size={14} />
            </>
          }
        >
          {(close) =>
            BLOCKS.map((b) => (
              <button
                key={b.id}
                type="button"
                className={`tb-pop-item tb-pop-${b.id}`}
                aria-pressed={block === b.id}
                onClick={() => {
                  if (editor) setBlock(editor, b.id);
                  close();
                  editor?.commands.focus();
                }}
              >
                {b.label}
              </button>
            ))
          }
        </ToolbarMenu>
        {btn(`Bold (${keyLabel(MOD, 'B')})`, <Bold />, () => chain().toggleBold().run(), { active: s?.bold })}
        {btn(`Italic (${keyLabel(MOD, 'I')})`, <Italic />, () => chain().toggleItalic().run(), { active: s?.italic })}
        {btn(`Underline (${keyLabel(MOD, 'U')})`, <Underline />, () => chain().toggleUnderline().run(), { active: s?.underline })}
        {btn(`Strikethrough (${keyLabel(MOD, SHIFT, 'S')})`, <Strikethrough />, () => chain().toggleStrike().run(), { active: s?.strike })}
        <ColorMenu editor={off ? null : editor} kind="text" />
        <ColorMenu editor={off ? null : editor} kind="highlight" />
        {btn('Clear formatting', <RemoveFormatting />, () => chain().unsetAllMarks().clearNodes().run())}
      </Group>
      <Sep />
      <Group label="Lists">
        {btn('Bulleted list', <List />, () => chain().toggleBulletList().run(), { active: s?.bullet })}
        {btn('Numbered list', <ListOrdered />, () => chain().toggleOrderedList().run(), { active: s?.ordered })}
        {btn('Checklist', <ListChecks />, () => chain().toggleTaskList().run(), { active: s?.check })}
        {btn(`Turn into task (${keyLabel(MOD, ENTER)})`, <CircleCheck />, () => chain().convertToTask().run(), { disabled: !s?.canTask, text: 'Task' })}
      </Group>
      <Sep />
      <Group label="Insert">
        {btn('Table', <Table />, () => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(), { text: 'Table' })}
        {btn('Image', <ImagePlus />, () => slashHooks.pickImage(editor!))}
        {btn('File attachment', <Paperclip />, () => slashHooks.pickFile(editor!))}
        {btn(`Link (${keyLabel(MOD, 'K')})`, <Link2 />, () => insertLink(editor!), { active: s?.link })}
        {btn('Link to page', <FileSymlink />, () => chain().insertContent('[[').run())}
        {btn('Divider', <Minus />, () => chain().setHorizontalRule().run())}
      </Group>
      <Sep />
      <Group label="Page">
        <ToolbarMenu
          label="Page colour"
          className="rb-text"
          disabled={pageOff}
          trigger={
            <>
              <PaintBucket />
              <span className="rb-btn-label">Page colour</span>
              <span className="rb-page-chip" data-page-color={settings.color} aria-hidden />
            </>
          }
        >
          {(close) => (
            <div className="color-choices">
              <div className="color-choices-label">Page colour</div>
              <div className="page-color-grid">
                {PAGE_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className="page-color-choice"
                    data-page-color={c}
                    title={PAGE_COLOR_LABELS[c]}
                    aria-label={`Page colour: ${PAGE_COLOR_LABELS[c]}`}
                    aria-pressed={settings.color === c}
                    onClick={() => {
                      if (page) setPageSettings(page.doc, { color: c });
                      close();
                    }}
                  />
                ))}
              </div>
            </div>
          )}
        </ToolbarMenu>
        <ToolbarMenu
          label="Rule lines"
          className="rb-text"
          disabled={pageOff}
          trigger={
            <>
              <Rows3 />
              <span className="rb-btn-label">Rule lines</span>
            </>
          }
        >
          {(close) =>
            RULE_LINES.map((r) => (
              <button
                key={r}
                type="button"
                className="tb-pop-item rb-rule-item"
                aria-label={`Rule lines: ${RULE_LABELS[r]}`}
                aria-pressed={settings.rules === r}
                onClick={() => {
                  if (page) setPageSettings(page.doc, { rules: r });
                  close();
                }}
              >
                {r === 'grid' ? <Grid3x3 size={16} /> : r === 'lines' ? <Rows3 size={16} /> : <span className="rb-rule-none" />}
                {RULE_LABELS[r]}
              </button>
            ))
          }
        </ToolbarMenu>
      </Group>
      <Sep />
      <Group label="View">
        {viewBtn('Panels', <PanelLeft />, () => ui.toggleSidebar(), { active: sidebarOpen })}
        {viewBtn('Outline', <ListTree />, () => setOutlineHidden(!outlineHidden), { active: !outlineHidden, disabled: !page })}
        {viewBtn('Comments', <MessageSquare />, () => setPagePanel(panel === 'comments' ? null : 'comments'), { active: panel === 'comments', disabled: !page })}
      </Group>
      <span className="tb-spacer" />
      <Group label="History">
        {btn(`Undo (${keyLabel(MOD, 'Z')})`, <Undo2 />, () => chain().undo().run(), { disabled: !s?.canUndo })}
        {btn(`Redo (${keyLabel(MOD, SHIFT, 'Z')})`, <Redo2 />, () => chain().redo().run(), { disabled: !s?.canRedo })}
      </Group>
      <button
        type="button"
        data-tb-item
        className="bm-btn rb-collapse"
        title="Collapse the ribbon"
        aria-label="Collapse the ribbon"
        aria-expanded
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setRibbonCollapsed(true)}
      >
        <ChevronUp size={16} />
      </button>
    </div>
  );
}

/** Move focus into the ribbon (its current item). Returns false when there is none. */
export function focusFixedToolbar(): boolean {
  const bar = document.querySelector<HTMLElement>('.ribbon');
  const item = bar?.querySelector<HTMLElement>(`${ITEM}[tabindex="0"]`) ?? bar?.querySelector<HTMLElement>(ITEM);
  if (!item || bar!.getBoundingClientRect().width === 0) return false;
  item.focus();
  return true;
}
