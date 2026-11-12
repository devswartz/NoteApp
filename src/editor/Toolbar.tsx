// The ribbon: a OneNote-style bar across the full width of the window, above the rail, the
// panels and the note (desktop and tablet; AppShell renders it). Its editing controls act on
// the page's active editor (./activeEditor.ts), its Page group on the open page's settings
// (./ribbonState.ts). Also the colour menus it shares with the floating toolbar over selected
// text (NoteEditor.tsx).
// WAI-ARIA toolbar pattern: one tab stop (roving tabindex), ←/→/Home/End move between
// controls, Escape returns to the text. Alt+F10 in the text and F6 focus it.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useEditorState, type Editor } from '@tiptap/react';
import {
  Baseline,
  BetweenHorizontalEnd,
  BetweenHorizontalStart,
  BetweenVerticalEnd,
  BetweenVerticalStart,
  Bold,
  Columns3,
  ChevronDown,
  ChevronUp,
  CircleCheck,
  Code2,
  Heading1,
  Heading2,
  Heading3,
  Pilcrow,
  Quote,
  FileSymlink,
  Grid3x3,
  Highlighter,
  ImagePlus,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  ListTree,
  Minus,
  PaintBucket,
  PanelTop,
  Paperclip,
  Printer,
  Redo2,
  RemoveFormatting,
  Rows3,
  Strikethrough,
  Table,
  TableCellsMerge,
  TableCellsSplit,
  Trash2,
  Underline,
  Undo2,
} from 'lucide-react';
import { canConvert } from './TaskRef.tsx';
import { listItemAt } from './smartLists.ts';
import { canInsertTask } from './taskGate.ts';
import { useActiveEditor } from './activeEditor.ts';
import { pageUndoOf, type PageUndo } from './pageUndo.ts';
import { openLinkEditor } from './LinkEditor.tsx';
import { slashHooks } from './SlashMenu.tsx';
import { printPage, printSelectionOnly } from './exportPage.ts';
import { usePrintSelection } from './boxSelection.ts';
import { applyColor, COLOR_LABELS, COLOR_NAMES, currentColor, type ColorKind, type ColorName } from './colors.ts';
import { setOutlineHidden, setRibbonCollapsed, syncRibbonPrefs, usePageSettings, useRibbon } from './ribbonState.ts';
import { PAGE_COLORS, RULE_LINES, setPageSettings, type PageColor, type RuleLines } from '../../shared/pageDoc.ts';
import { ENTER, MOD, Popover, SHIFT, keyLabel } from '../components/ui.tsx';
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

/** The same icons the floating toolbar and slash menu use for these blocks. */
const BLOCK_ICONS: Record<BlockId, ReactNode> = {
  p: <Pilcrow size={16} />,
  h1: <Heading1 size={16} />,
  h2: <Heading2 size={16} />,
  h3: <Heading3 size={16} />,
  quote: <Quote size={16} />,
  code: <Code2 size={16} />,
};

/** Tooltip of an editing control while there is no editor to act on. */
const IDLE_HINT = 'Click in a note to format';

/** The keyboard shortcut of a block type (TipTap's own, OneNote's for headings), if it has one. */
const ALT = MOD === '⌘' ? '⌥' : 'Alt';
const blockKey = (id: BlockId) =>
  id === 'p' ? keyLabel(MOD, ALT, '0') : id.startsWith('h') ? keyLabel(MOD, ALT, id.slice(1)) : id === 'code' ? keyLabel(MOD, ALT, 'C') : '';

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
  title,
  children,
}: {
  label: string;
  trigger: ReactNode;
  className?: string;
  disabled?: boolean;
  /** Tooltip, when it differs from the label. */
  title?: string;
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
        title={title ?? label}
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
      title={editor ? undefined : IDLE_HINT}
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
    inList: !!listItemAt(e),
    link: e.isActive('link'),
    canTask: canConvert(e),
    taskAllowed: canInsertTask(e),
    canUndo: e.can().undo(),
    canRedo: e.can().redo(),
    table: e.isActive('table') ? { header: headerRowOn(e), merge: e.can().mergeCells(), split: e.can().splitCell() } : null,
  };
}

const noSubscribe = () => () => {};
const noVersion = () => 0;

/**
 * Undo / Redo: on a canvas page, the page's most recent change (a box moved or typed in,
 * wherever focus is; pageUndo.ts); otherwise the editor's own history.
 */
function useHistory(editor: Editor | null, s: { canUndo: boolean; canRedo: boolean } | null) {
  const page: PageUndo | null = pageUndoOf(editor);
  useSyncExternalStore(page?.subscribe ?? noSubscribe, page?.getVersion ?? noVersion);
  if (!page) {
    return {
      canUndo: !!s?.canUndo,
      canRedo: !!s?.canRedo,
      undo: () => void editor?.chain().focus().undo().run(),
      redo: () => void editor?.chain().focus().redo().run(),
    };
  }
  // Presses keep focus where it is (mousedown is prevented): in the text, or on a selected box.
  return { canUndo: page.canUndo(), canRedo: page.canRedo(), undo: () => void page.undo(), redo: () => void page.redo() };
}

/** Whether the first row of the table at the selection is a header row. */
function headerRowOn(e: Editor) {
  const { $from } = e.state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (node.type.name !== 'table') continue;
    const row = node.firstChild;
    if (!row || !row.childCount) return false;
    let all = true;
    row.forEach((cell) => (all &&= cell.type.name === 'tableHeader'));
    return all;
  }
  return false;
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

/** Link: edits the link at the selection; with nothing selected, opens the editor to insert a new link at the cursor. */
function insertLink(editor: Editor) {
  openLinkEditor(editor, { insert: true });
}

export const Sep = () => <span className="bm-sep rb-sep" aria-hidden />;

/** A ribbon group with its small OneNote-style label underneath (hidden on narrow windows; it still names the group). */
export function Group({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
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
  /** The button's name when it differs from its text. */
  label?: string;
}

/** Ctrl+F1 collapses / restores the ribbon (as in Office), in every section. */
function useCollapseShortcut() {
  useEffect(syncRibbonPrefs, []); // the shell's storage is ready now (see store/ui.ts)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'F1' || !e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return;
      e.preventDefault();
      setRibbonCollapsed(!useRibbon.getState().collapsed);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/**
 * The ribbon's frame, the same in every section: a WAI-ARIA toolbar with roving focus, the
 * collapse chevron at its end, and the collapsed strip (naming the groups) that restores on
 * click. Collapsed or not is remembered on this device, across sections.
 */
export function RibbonFrame({
  strip,
  editor = null,
  idle = false,
  section = false,
  context = false,
  children,
}: {
  strip: string;
  editor?: Editor | null;
  idle?: boolean;
  /** A contextual group (Table) is showing: the other groups give up their text sooner. */
  context?: boolean;
  /** Tasks, Calendar, Notes, Settings (not the note's ribbon). */
  section?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const roving = useRovingTabIndex(ref);
  const collapsed = useRibbon((r) => r.collapsed);
  useCollapseShortcut();
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
        <span className="rb-strip-groups" aria-hidden onClick={() => setRibbonCollapsed(false)}>
          {strip}
        </span>
        <button
          type="button"
          data-tb-item
          className="bm-btn rb-expand"
          title="Show the ribbon (Ctrl+F1)"
          aria-label="Show the ribbon"
          aria-expanded={false}
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setRibbonCollapsed(false)}
        >
          <span>Show ribbon</span>
          <ChevronDown size={14} />
        </button>
      </div>
    );
  return (
    <div
      ref={ref}
      className={`ribbon ${idle ? 'is-idle' : ''} ${section ? 'is-section' : ''} ${context ? 'has-context' : ''}`}
      role="toolbar"
      aria-label="Ribbon"
      aria-orientation="horizontal"
      onFocus={roving.onFocus}
      onKeyDown={(e) => toolbarKeys(e, editor)}
    >
      {children}
      <button
        type="button"
        data-tb-item
        className="bm-btn rb-collapse"
        title="Collapse the ribbon (Ctrl+F1)"
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

/** A ribbon button outside the note's ribbon (Tasks, Calendar, Notes, Settings): same look, its own reason when disabled. */
export function RibbonButton({
  label,
  icon,
  onClick,
  text,
  active,
  disabled,
  title,
}: {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  /** Visible text next to the icon (dropped on narrow windows). */
  text?: string;
  /** Toggle / current state: shows as pressed. */
  active?: boolean;
  /** A reason string disables the button and becomes its tooltip. */
  disabled?: string | false;
  title?: string;
}) {
  const on = !disabled && !!active;
  return (
    <button
      type="button"
      data-tb-item
      className={`bm-btn rb-btn ${on ? 'is-active' : ''} ${text ? 'rb-text' : ''}`}
      title={disabled || title || label}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : on}
      aria-disabled={disabled ? true : undefined}
      tabIndex={-1}
      onClick={() => !disabled && onClick()}
    >
      {icon}
      {text && <span className="rb-btn-label">{text}</span>}
    </button>
  );
}

/**
 * A ribbon button that opens an app menu (MenuItem rows) in a popover. `count` shows a small
 * badge and highlights the button, so an active filter stays visible while the menu is closed.
 */
export function RibbonMenu({
  label,
  icon,
  text,
  count,
  disabled,
  title,
  bare = false,
  compact = false,
  children,
}: {
  label: string;
  icon?: ReactNode;
  text?: string;
  count?: number;
  disabled?: string | false;
  title?: string;
  /** The content brings its own .menu wrapper. */
  bare?: boolean;
  /** Its text goes first when the window is not wide enough for every label. */
  compact?: boolean;
  children: ReactNode | ((close: () => void) => ReactNode);
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    // Focus the first row so the menu works from the keyboard (↑/↓ move, Escape returns).
    if (!open) return;
    const t = setTimeout(() => pop.current?.querySelector<HTMLElement>('.menu-item')?.focus());
    return () => clearTimeout(t);
  }, [open]);
  const on = !disabled && !!count;
  return (
    <>
      <button
        ref={ref}
        type="button"
        data-tb-item
        className={`bm-btn rb-btn rb-menu-btn ${on ? 'is-active' : ''} ${text ? 'rb-text' : ''} ${compact ? 'rb-compact' : ''}`}
        title={disabled || title || label}
        aria-label={label}
        aria-haspopup="true"
        aria-expanded={open}
        aria-disabled={disabled ? true : undefined}
        tabIndex={-1}
        onClick={() => !disabled && setOpen((o) => !o)}
      >
        {icon}
        {text && <span className="rb-btn-label">{text}</span>}
        {on && (
          <span className="rb-count" aria-hidden>
            {count}
          </span>
        )}
        <ChevronDown size={12} className="rb-caret" />
      </button>
      <Popover anchor={ref} open={open && !disabled} onClose={close} className="rb-popover">
        <div className={bare ? undefined : 'menu filter-menu'} ref={pop}>
          {typeof children === 'function' ? children(close) : children}
        </div>
      </Popover>
    </>
  );
}

/**
 * The note's ribbon (OneNote's Home tab, one tab only). Editing controls act on the active editor,
 * the one last focused on the open page; with none (an empty canvas, a viewer) they are
 * disabled, not hidden. The Page group needs a page you may edit; View always works.
 * Presses keep the editor's selection (mousedown is prevented).
 */
export function Ribbon() {
  const active = useActiveEditor();
  const editor = active && !active.isDestroyed && active.isEditable ? active : null;
  const s = useEditorState({ editor, selector: ({ editor: e }) => (e && !e.isDestroyed ? ribbonState(e) : null) });
  const page = useRibbon((r) => r.page);
  const outlineHidden = useRibbon((r) => r.outlineHidden);
  const printable = usePrintSelection(page?.pageId);
  const settings = usePageSettings(page?.doc);
  const off = !editor || !s;
  const pageOff = !page || !page.canEdit;
  const chain = () => editor!.chain().focus();
  const history = useHistory(editor, s);
  const button = (title: string, icon: ReactNode, run: () => void, opts: BtnOpts & { always?: boolean } = {}) => {
    const idle = !opts.always && off;
    const disabled = idle || !!opts.disabled;
    const on = !disabled && !!opts.active;
    return (
      <button
        type="button"
        data-tb-item
        className={`bm-btn rb-btn ${on ? 'is-active' : ''} ${opts.text ? 'rb-text' : ''}`}
        title={idle ? IDLE_HINT : title}
        aria-label={opts.label ?? opts.text ?? title}
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

  const table = editor && s?.table ? s.table : null;
  const block = s?.block ?? 'p';
  const blockLabel = BLOCKS.find((b) => b.id === block)!.label;
  return (
    <RibbonFrame strip={`Text · Lists · Insert${table ? ' · Table' : ''} · Page · View`} editor={editor} idle={off} context={!!table}>
      <Group label="Text">
        <ToolbarMenu
          label={`Block type: ${blockLabel}`}
          title={off ? IDLE_HINT : undefined}
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
                title={blockKey(b.id) ? `${b.label} (${blockKey(b.id)})` : undefined}
                onClick={() => {
                  if (editor) setBlock(editor, b.id);
                  close();
                  editor?.commands.focus();
                }}
              >
                <span className="tb-pop-icon" aria-hidden>
                  {BLOCK_ICONS[b.id]}
                </span>
                <span className="tb-pop-text">{b.label}</span>
                {blockKey(b.id) && (
                  <kbd className="tb-pop-key" aria-hidden>
                    {blockKey(b.id)}
                  </kbd>
                )}
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
        {btn(`Bulleted list (${keyLabel(MOD, '.')})`, <List />, () => chain().toggleBulletList().run(), { active: s?.bullet })}
        {btn(`Numbered list (${keyLabel(MOD, SHIFT, '7')})`, <ListOrdered />, () => chain().toggleOrderedList().run(), { active: s?.ordered })}
        {btn('Decrease indent (Shift+Tab)', <IndentDecrease />, () => chain().outdentListItem().run(), { disabled: !s?.inList })}
        {btn('Increase indent (Tab)', <IndentIncrease />, () => chain().indentListItem().run(), { disabled: !s?.inList })}
        <span className="rb-split">
          {btn(
            `Task: make this line a tracked task, or start a new one (${keyLabel(MOD, '1')} or ${keyLabel(MOD, ENTER)})`,
            <CircleCheck />,
            () => (s?.canTask ? chain().convertToTask().run() : chain().insertTask().run()),
            { text: 'Task', disabled: s ? !s.taskAllowed : false },
          )}
          <ToolbarMenu
            label="More list options"
            title={off ? IDLE_HINT : 'Plain checkbox'}
            className="rb-split-arrow"
            disabled={off}
            trigger={<ChevronDown size={14} />}
          >
            {(close) => (
              <button
                type="button"
                className="tb-pop-item rb-rule-item"
                title="A plain checkbox item: no due date or assignee, not on the Tasks dashboard"
                onClick={() => {
                  close();
                  chain().toggleTaskList().run();
                }}
              >
                <ListChecks size={16} />
                Plain checkbox
              </button>
            )}
          </ToolbarMenu>
        </span>
      </Group>
      <Sep />
      <Group label="Insert">
        {!table && btn('Table', <Table />, () => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(), { text: 'Table' })}
        {btn('Image', <ImagePlus />, () => slashHooks.pickImage(editor!))}
        {btn('File attachment', <Paperclip />, () => slashHooks.pickFile(editor!))}
        {btn(`Link (${keyLabel(MOD, 'K')})`, <Link2 />, () => insertLink(editor!), { active: s?.link })}
        {btn('Link to page', <FileSymlink />, () => chain().insertContent('[[').run())}
        {btn('Divider', <Minus />, () => chain().setHorizontalRule().run())}
      </Group>
      {table && (
        <>
          <Sep />
          {/* Contextual, as Office's Table tab: only while the selection is in a table. */}
          <Group label="Table" className="rb-context">
            {btn('Insert row above', <BetweenHorizontalStart />, () => chain().addRowBefore().run())}
            {btn('Insert row below', <BetweenHorizontalEnd />, () => chain().addRowAfter().run(), { text: 'Row below', label: 'Insert row below' })}
            {btn('Insert column left', <BetweenVerticalStart />, () => chain().addColumnBefore().run())}
            {btn('Insert column right', <BetweenVerticalEnd />, () => chain().addColumnAfter().run(), { text: 'Column right', label: 'Insert column right' })}
            {btn('Header row', <PanelTop />, () => chain().toggleHeaderRow().run(), { active: table.header })}
            {btn('Merge cells (select cells first)', <TableCellsMerge />, () => chain().mergeCells().run(), { disabled: !table.merge, label: 'Merge cells' })}
            {btn('Split cell', <TableCellsSplit />, () => chain().splitCell().run(), { disabled: !table.split })}
            {btn('Delete row', <Rows3 />, () => chain().deleteRow().run())}
            {btn('Delete column', <Columns3 />, () => chain().deleteColumn().run())}
            {btn('Delete table', <Trash2 />, () => chain().deleteTable().run())}
          </Group>
        </>
      )}
      <Sep />
      <Group label="Page">
        <ToolbarMenu
          label="Page colour"
          className="rb-text"
          disabled={pageOff}
          trigger={
            <>
              <span className="rb-icon-bar">
                <PaintBucket />
                <span className="tb-color-bar is-page" data-page-color={settings.color} aria-hidden />
              </span>
              <span className="rb-btn-label">Page colour</span>
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
        {viewBtn(`Print (${keyLabel(MOD, 'P')})`, <Printer />, () => printPage(), { text: 'Print', disabled: !page })}
        {printable && viewBtn(printable === 'boxes' ? 'Print the selected boxes' : printable === 'lines' ? 'Print the selected lines' : 'Print the selected text', <Printer />, () => printSelectionOnly(), { text: 'Print selection' })}
      </Group>
      <Sep />
      <Group label="View">
        {viewBtn('Outline', <ListTree />, () => setOutlineHidden(!outlineHidden), { active: !outlineHidden, disabled: !page })}
      </Group>
      <span className="tb-spacer" />
      <Group label="History">
        {btn(`Undo (${keyLabel(MOD, 'Z')})`, <Undo2 />, history.undo, { disabled: !history.canUndo })}
        {btn(`Redo (${keyLabel(MOD, SHIFT, 'Z')})`, <Redo2 />, history.redo, { disabled: !history.canRedo })}
      </Group>
    </RibbonFrame>
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
