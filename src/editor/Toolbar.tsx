// The fixed formatting toolbar at the top of the editor (desktop and tablet), and the
// colour menus it shares with the floating toolbar over selected text (NoteEditor.tsx).
// WAI-ARIA toolbar pattern: one tab stop (roving tabindex), ←/→/Home/End move between
// controls, Escape returns to the text. Alt+F10 in the text focuses it (NoteEditor.tsx).
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useEditorState, type Editor } from '@tiptap/react';
import {
  Baseline,
  Bold,
  ChevronDown,
  CircleCheck,
  Highlighter,
  ImagePlus,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Redo2,
  Strikethrough,
  Table,
  Underline,
  Undo2,
} from 'lucide-react';
import { canConvert } from './TaskRef.tsx';
import { openLinkEditor } from './LinkEditor.tsx';
import { slashHooks } from './SlashMenu.tsx';
import { applyColor, COLOR_LABELS, COLOR_NAMES, currentColor, type ColorKind, type ColorName } from './colors.ts';
import { ENTER, MOD, SHIFT, keyLabel } from '../components/ui.tsx';
import '../styles/colors.css';
import '../styles/toolbar.css';

const BLOCKS = [
  { id: 'p', label: 'Text' },
  { id: 'h1', label: 'Heading 1' },
  { id: 'h2', label: 'Heading 2' },
  { id: 'h3', label: 'Heading 3' },
] as const;
type BlockId = (typeof BLOCKS)[number]['id'];

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
export function toolbarKeys(e: React.KeyboardEvent<HTMLElement>, editor: Editor, selector = ITEM) {
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
  else if (e.key === 'Escape') {
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
  children,
}: {
  label: string;
  trigger: ReactNode;
  className?: string;
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
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
      >
        {trigger}
      </button>
      {open && (
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
export function ColorMenu({ editor, kind }: { editor: Editor; kind: ColorKind }) {
  const color = useEditorState({ editor, selector: ({ editor: e }) => currentColor(e, kind) });
  const label = kind === 'text' ? 'Text colour' : 'Highlight';
  return (
    <ToolbarMenu
      label={label}
      trigger={
        <>
          {kind === 'text' ? <Baseline size={16} /> : <Highlighter size={16} />}
          <span className={`tb-color-bar ${kind === 'text' ? 'is-text' : 'is-hl'}`} data-color={color ?? undefined} aria-hidden />
        </>
      }
    >
      {(close) => <ColorChoices editor={editor} kind={kind} done={close} />}
    </ToolbarMenu>
  );
}

export function EditorToolbar({ editor }: { editor: Editor }) {
  const ref = useRef<HTMLDivElement>(null);
  const roving = useRovingTabIndex(ref);
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      block: (e.isActive('heading', { level: 1 }) ? 'h1' : e.isActive('heading', { level: 2 }) ? 'h2' : e.isActive('heading', { level: 3 }) ? 'h3' : 'p') as BlockId,
      textBlock: e.state.selection.$from.parent.isTextblock && !e.isActive('codeBlock'),
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      check: e.isActive('taskList'),
      link: e.isActive('link'),
      canLink: !e.state.selection.empty || e.isActive('link'),
      canTask: canConvert(e),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });
  const chain = () => editor.chain().focus();
  const btn = (title: string, icon: ReactNode, run: () => void, opts: { active?: boolean; disabled?: boolean; text?: string } = {}) => (
    <button
      type="button"
      data-tb-item
      className={`bm-btn ${opts.active ? 'is-active' : ''} ${opts.text ? 'bm-text' : ''}`}
      title={title}
      aria-label={opts.text ? undefined : title}
      aria-pressed={opts.active === undefined ? undefined : opts.active}
      aria-disabled={opts.disabled || undefined}
      tabIndex={-1}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => !opts.disabled && run()}
    >
      {icon}
      {opts.text}
    </button>
  );
  const blockLabel = BLOCKS.find((b) => b.id === s.block)!.label;
  return (
    <div
      ref={ref}
      className="editor-toolbar"
      role="toolbar"
      aria-label="Editor toolbar"
      aria-orientation="horizontal"
      contentEditable={false}
      onFocus={roving.onFocus}
      onKeyDown={(e) => toolbarKeys(e, editor)}
    >
      <ToolbarMenu label={`Block type: ${blockLabel}`} className="tb-block" trigger={<><span className="tb-block-label">{blockLabel}</span><ChevronDown size={14} /></>}>
        {(close) =>
          BLOCKS.map((b) => (
            <button
              key={b.id}
              type="button"
              className={`tb-pop-item tb-pop-${b.id}`}
              aria-pressed={s.block === b.id}
              onClick={() => {
                if (b.id === 'p') chain().setParagraph().run();
                else chain().setHeading({ level: Number(b.id.slice(1)) as 1 | 2 | 3 }).run();
                close();
                editor.commands.focus();
              }}
            >
              {b.label}
            </button>
          ))
        }
      </ToolbarMenu>
      <span className="bm-sep" />
      {btn(`Bold (${keyLabel(MOD, 'B')})`, <Bold size={16} />, () => chain().toggleBold().run(), { active: s.bold })}
      {btn(`Italic (${keyLabel(MOD, 'I')})`, <Italic size={16} />, () => chain().toggleItalic().run(), { active: s.italic })}
      {btn(`Underline (${keyLabel(MOD, 'U')})`, <Underline size={16} />, () => chain().toggleUnderline().run(), { active: s.underline })}
      {btn(`Strikethrough (${keyLabel(MOD, SHIFT, 'S')})`, <Strikethrough size={16} />, () => chain().toggleStrike().run(), { active: s.strike })}
      <ColorMenu editor={editor} kind="text" />
      <ColorMenu editor={editor} kind="highlight" />
      <span className="bm-sep" />
      {btn('Bulleted list', <List size={16} />, () => chain().toggleBulletList().run(), { active: s.bullet })}
      {btn('Numbered list', <ListOrdered size={16} />, () => chain().toggleOrderedList().run(), { active: s.ordered })}
      {btn('Checklist', <ListChecks size={16} />, () => chain().toggleTaskList().run(), { active: s.check })}
      {btn(`Turn into task (${keyLabel(MOD, ENTER)})`, <CircleCheck size={16} />, () => chain().convertToTask().run(), { disabled: !s.canTask, text: 'Task' })}
      <span className="bm-sep" />
      {btn(`Link (${keyLabel(MOD, 'K')})`, <Link2 size={16} />, () => openLinkEditor(editor), { active: s.link, disabled: !s.canLink })}
      {btn('Image', <ImagePlus size={16} />, () => slashHooks.pickImage?.(editor))}
      {btn('Table', <Table size={16} />, () => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run())}
      <span className="tb-spacer" />
      {btn(`Undo (${keyLabel(MOD, 'Z')})`, <Undo2 size={16} />, () => chain().undo().run(), { disabled: !s.canUndo })}
      {btn(`Redo (${keyLabel(MOD, SHIFT, 'Z')})`, <Redo2 size={16} />, () => chain().redo().run(), { disabled: !s.canRedo })}
    </div>
  );
}

/** Move focus into the fixed toolbar (its current item). Returns false when there is none. */
export function focusFixedToolbar(): boolean {
  const bar = document.querySelector<HTMLElement>('.editor-toolbar');
  const item = bar?.querySelector<HTMLElement>(`${ITEM}[tabindex="0"]`) ?? bar?.querySelector<HTMLElement>(ITEM);
  if (!item || bar!.getBoundingClientRect().width === 0) return false;
  item.focus();
  return true;
}
