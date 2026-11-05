import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type RefObject,
  forwardRef,
  useId,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  createContext,
  useContext,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, Loader2, X } from 'lucide-react';
import { initials } from '../lib/format.ts';

// ───────────── Popover ─────────────

const PopoverCtx = createContext<() => void>(() => {});
export const useClosePopover = () => useContext(PopoverCtx);

interface PopoverProps {
  anchor: RefObject<HTMLElement | null>;
  /** Position at a point instead of below the anchor (context menus). */
  point?: { x: number; y: number } | null;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  placement?: 'bottom-start' | 'bottom-end' | 'top-start';
  className?: string;
}

/** Floating panel anchored to an element; closes on outside click and Escape. */
export function Popover({ anchor, point, open, onClose, children, placement = 'bottom-start', className }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !ref.current || (!point && !anchor.current)) return;
    const a = point ? new DOMRect(point.x, point.y, 0, 0) : anchor.current!.getBoundingClientRect();
    const p = ref.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = placement === 'bottom-end' ? a.right - p.width : a.left;
    let top = placement === 'top-start' ? a.top - p.height - 6 : a.bottom + 6;
    if (top + p.height > vh - 8) top = Math.max(8, a.top - p.height - 6);
    left = Math.min(Math.max(8, left), vw - p.width - 8);
    setPos({ top, left });
  }, [open, anchor, placement, point]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || (!point && anchor.current?.contains(t))) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        anchor.current?.focus({ preventScroll: true });
        return;
      }
      // Arrow keys move between menu items (unless typing in a field inside the popover).
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && ref.current) {
        const t = e.target as HTMLElement;
        if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return;
        const items = [...ref.current.querySelectorAll<HTMLElement>('.menu-item:not(:disabled)')];
        if (!items.length) return;
        e.preventDefault();
        const i = items.indexOf(document.activeElement as HTMLElement);
        const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
        items[i < 0 ? (e.key === 'ArrowDown' ? 0 : items.length - 1) : next].focus();
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, onClose, anchor, point]);

  if (!open) return null;
  return createPortal(
    <PopoverCtx.Provider value={onClose}>
      <div
        ref={ref}
        className={`popover ${className ?? ''}`}
        style={pos ? { top: pos.top, left: pos.left } : { top: -9999, left: -9999 }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </PopoverCtx.Provider>,
    document.body,
  );
}

/**
 * Right-click / long-press menu. Spread `bind` onto the target element and
 * render `menu` anywhere. `open()` also works from a "⋯" button.
 */
export function useContextMenu(render: (close: () => void) => ReactNode) {
  const anchor = useRef<HTMLElement | null>(null);
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const close = () => setPoint(null);
  const longPress = useRef<number | undefined>(undefined);
  const pressed = useRef(false);
  const bind = {
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setPoint({ x: e.clientX, y: e.clientY });
    },
    // Touch: long-press opens the menu (iOS Safari doesn't fire contextmenu).
    onTouchStart: (e: React.TouchEvent) => {
      const t = e.touches[0];
      pressed.current = false;
      window.clearTimeout(longPress.current);
      longPress.current = window.setTimeout(() => {
        pressed.current = true;
        setPoint({ x: t.clientX, y: t.clientY });
      }, 500);
    },
    // The finger lifting after a long-press must not also "tap" the row.
    onClickCapture: (e: React.MouseEvent) => {
      if (!pressed.current) return;
      pressed.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
    onTouchEnd: (e: React.TouchEvent) => {
      window.clearTimeout(longPress.current);
      // After a long-press, cancel the click the browser would synthesize on release
      // (it could land on an item of the menu that just opened under the finger).
      if (pressed.current) e.preventDefault();
    },
    onTouchMove: () => window.clearTimeout(longPress.current),
  };
  // On phones the menu opens as a bottom sheet (bigger targets, thumb reach).
  const sheet = typeof window !== 'undefined' && window.matchMedia('(max-width: 760px) and (pointer: coarse)').matches;
  const menu = (
    <Popover anchor={anchor} point={point} open={!!point} onClose={close} className={sheet ? 'as-sheet' : undefined}>
      {point ? render(close) : null}
    </Popover>
  );
  return { bind, menu, openAt: (x: number, y: number) => setPoint({ x, y }), close };
}

/** Button + popover pair. */
export function Dropdown({
  trigger,
  children,
  placement,
  className,
  buttonClass = 'btn-ghost',
  title,
  disabled,
}: {
  trigger: ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  placement?: PopoverProps['placement'];
  className?: string;
  buttonClass?: string;
  title?: string;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={buttonClass}
        title={title}
        aria-label={title}
        disabled={disabled}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        {trigger}
      </button>
      <Popover anchor={ref} open={open} onClose={close} placement={placement} className={className}>
        {typeof children === 'function' ? children(close) : children}
      </Popover>
    </>
  );
}

export function MenuItem({
  icon,
  children,
  onSelect,
  checked,
  danger,
  hint,
  keepOpen,
}: {
  icon?: ReactNode;
  children: ReactNode;
  onSelect: () => void;
  checked?: boolean;
  danger?: boolean;
  hint?: ReactNode;
  keepOpen?: boolean;
}) {
  const close = useClosePopover();
  return (
    <button
      type="button"
      role="menuitem"
      className={`menu-item ${danger ? 'danger' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
        if (!keepOpen) close();
      }}
    >
      <span className="menu-icon">{icon}</span>
      <span className="menu-label">{children}</span>
      {hint && <span className="menu-hint">{hint}</span>}
      {checked && <Check size={14} className="menu-check" />}
    </button>
  );
}

export const MenuSeparator = () => <div className="menu-sep" />;
export const MenuLabel = ({ children }: { children: ReactNode }) => <div className="menu-label-row">{children}</div>;

// ───────────── Avatar ─────────────

export function Avatar({
  user,
  size = 22,
  title,
}: {
  user: { name: string; color: string } | null | undefined;
  size?: number;
  title?: string;
}) {
  if (!user)
    return (
      <span className="avatar avatar-empty" style={{ width: size, height: size }} title={title ?? 'Unassigned'} />
    );
  return (
    <span
      className="avatar"
      style={{ width: size, height: size, background: user.color, fontSize: size * 0.42 }}
      title={title ?? user.name}
    >
      {initials(user.name)}
    </span>
  );
}

// ───────────── Modal / Dialog ─────────────

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** Keeps Tab inside `ref` and returns focus to the previously focused element on unmount. */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const previous = document.activeElement as HTMLElement | null;
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) {
      // Respect autoFocus children; otherwise focus the first focusable element.
      requestAnimationFrame(() => {
        if (!el.contains(document.activeElement)) (el.querySelector<HTMLElement>(FOCUSABLE) ?? el).focus();
      });
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !ref.current) return;
      const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
      else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, [active, ref]);
}

export function Modal({
  open,
  onClose,
  children,
  className,
  label,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, open);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} tabIndex={-1} className={`modal ${className ?? ''}`} role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** A titled dialog with an optional description and a footer of actions. */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}) {
  return (
    <Modal open={open} onClose={onClose} label={title} className={`dialog dialog-${size}`}>
      <div className="dialog-head">
        <h2 className="dialog-title">{title}</h2>
        <IconButton label="Close" size="sm" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </div>
      {description && <p className="dialog-desc">{description}</p>}
      {children && <div className="dialog-body">{children}</div>}
      {footer && <div className="dialog-foot">{footer}</div>}
    </Modal>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = isMac ? '⌘' : 'Ctrl';

export function useMediaQuery(q: string): boolean {
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const fn = () => setM(mq.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, [q]);
  return m;
}

export const useIsMobile = () => useMediaQuery('(max-width: 760px)');

// ───────────── Segmented control ─────────────

/** A small set of mutually exclusive options (radio group semantics). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  size = 'md',
}: {
  value: T;
  options: { value: T; label: string; icon?: ReactNode }[];
  onChange: (v: T) => void;
  label: string;
  size?: 'sm' | 'md';
}) {
  const move = (dir: 1 | -1) => {
    const i = options.findIndex((o) => o.value === value);
    onChange(options[(i + dir + options.length) % options.length].value);
  };
  return (
    <div
      className={`segmented segmented-${size}`}
      role="radiogroup"
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') (e.preventDefault(), move(1));
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') (e.preventDefault(), move(-1));
      }}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          className={`segment ${o.value === value ? 'is-active' : ''}`}
          onClick={() => onChange(o.value)}
        >
          {o.icon}
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

// ───────────── Button / IconButton ─────────────

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  loading?: boolean;
}

/** The standard button. Maps onto the .btn classes so old markup and new components look the same. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, loading, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  const cls = [variant === 'ghost' ? 'btn-ghost' : `btn btn-${variant}`, size !== 'md' && `btn-${size}`, loading && 'is-loading', className]
    .filter(Boolean)
    .join(' ');
  return (
    <button ref={ref} type={type} className={cls} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <Loader2 size={15} className="spin" /> : icon}
      {children}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> {
  /** Accessible name; also shown as the tooltip. */
  label: string;
  /** Optional shortcut shown in the tooltip, in useShortcuts syntax-free display form ("⌘K"). */
  shortcut?: string;
  size?: 'sm' | 'md' | 'lg';
  active?: boolean;
  tooltip?: boolean;
}

/** Square icon-only button with a required label (aria-label + tooltip). */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, shortcut, size = 'md', active, tooltip = true, className, children, type = 'button', ...rest },
  ref,
) {
  const btn = (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={tooltip ? undefined : label}
      aria-pressed={active}
      className={`btn-ghost icon-btn ${size === 'sm' ? 'sm' : size === 'lg' ? 'lg' : ''} ${active ? 'is-active' : ''} ${className ?? ''}`}
      {...rest}
    >
      {children}
    </button>
  );
  return tooltip ? <Tooltip content={label} shortcut={shortcut}>{btn}</Tooltip> : btn;
});

// ───────────── Tooltip ─────────────

/**
 * Hover/focus tooltip. Wraps a single focusable child. Not shown on touch
 * devices (no hover), so never put essential information only in a tooltip.
 */
export function Tooltip({
  content,
  shortcut,
  children,
  side = 'bottom',
}: {
  content: ReactNode;
  shortcut?: string;
  children: ReactNode;
  side?: 'top' | 'bottom' | 'right';
}) {
  const wrap = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const id = useId();

  const show = () => {
    if (!window.matchMedia('(hover: hover)').matches) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setShown(true), 450);
  };
  const hide = () => {
    window.clearTimeout(timer.current);
    setShown(false);
    setPos(null);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const tip = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!shown || !wrap.current || !tip.current) return;
    const target = (wrap.current.firstElementChild as HTMLElement | null) ?? wrap.current;
    const a = target.getBoundingClientRect();
    const t = tip.current.getBoundingClientRect();
    let top = side === 'top' ? a.top - t.height - 6 : side === 'right' ? a.top + (a.height - t.height) / 2 : a.bottom + 6;
    let left = side === 'right' ? a.right + 6 : a.left + (a.width - t.width) / 2;
    left = Math.min(Math.max(6, left), window.innerWidth - t.width - 6);
    if (top + t.height > window.innerHeight - 6) top = a.top - t.height - 6;
    setPos({ top: Math.max(6, top), left });
  }, [shown, side]);

  return (
    <span ref={wrap} className="tooltip-anchor" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide} onPointerDown={hide} aria-describedby={shown ? id : undefined}>
      {children}
      {shown &&
        createPortal(
          <div ref={tip} id={id} role="tooltip" className="tooltip" style={pos ?? { top: -9999, left: -9999 }}>
            {content}
            {shortcut && <span className="tooltip-kbd">{shortcut}</span>}
          </div>,
          document.body,
        )}
    </span>
  );
}

// ───────────── Input ─────────────

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  icon?: ReactNode;
}

/** Text input with optional label, hint and error, wired up for screen readers. */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, size = 'md', icon, className, id, ...rest },
  ref,
) {
  const auto = useId();
  const inputId = id ?? auto;
  const hintId = hint || error ? `${inputId}-hint` : undefined;
  const input = (
    <span className={`input-wrap ${icon ? 'has-icon' : ''}`}>
      {icon && <span className="input-icon">{icon}</span>}
      <input
        ref={ref}
        id={inputId}
        className={`input ${size === 'sm' ? 'input-sm' : size === 'lg' ? 'input-lg' : ''} ${error ? 'is-invalid' : ''} ${className ?? ''}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={hintId}
        {...rest}
      />
    </span>
  );
  if (!label && !hint && !error) return input;
  return (
    <div className="field">
      {label && (
        <label className="field-label" htmlFor={inputId}>
          {label}
        </label>
      )}
      {input}
      {(error || hint) && (
        <div id={hintId} className={`field-hint ${error ? 'is-error' : ''}`}>
          {error || hint}
        </div>
      )}
    </div>
  );
});

// ───────────── Tabs ─────────────

/** Accessible tab strip (role=tablist, arrow keys). Render the panel yourself based on `value`. */
export function Tabs<T extends string>({
  value,
  onChange,
  tabs,
  label,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  tabs: { value: T; label: ReactNode; icon?: ReactNode; count?: number }[];
  label: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const focusTab = (i: number) => {
    const t = tabs[(i + tabs.length) % tabs.length];
    onChange(t.value);
    requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus());
  };
  const cur = tabs.findIndex((t) => t.value === value);
  return (
    <div
      ref={ref}
      role="tablist"
      aria-label={label}
      className={`tabs ${className ?? ''}`}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') (e.preventDefault(), focusTab(cur + 1));
        if (e.key === 'ArrowLeft') (e.preventDefault(), focusTab(cur - 1));
        if (e.key === 'Home') (e.preventDefault(), focusTab(0));
        if (e.key === 'End') (e.preventDefault(), focusTab(tabs.length - 1));
      }}
    >
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          aria-selected={t.value === value}
          tabIndex={t.value === value ? 0 : -1}
          className={`tab-btn ${t.value === value ? 'is-active' : ''}`}
          onClick={() => onChange(t.value)}
        >
          {t.icon}
          <span>{t.label}</span>
          {t.count !== undefined && <Badge>{t.count}</Badge>}
        </button>
      ))}
    </div>
  );
}

// ───────────── Badge ─────────────

export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'success' | 'warn' | 'danger';
  className?: string;
}) {
  return <span className={`badge badge-${tone} ${className ?? ''}`}>{children}</span>;
}

// ───────────── Empty state ─────────────

export function EmptyState({
  icon,
  title,
  description,
  action,
  compact,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`empty-state ${compact ? 'is-compact' : ''}`} role="status">
      {icon && <div className="empty-state-icon">{icon}</div>}
      <strong>{title}</strong>
      {description && <p className="empty-state-desc">{description}</p>}
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  );
}

// ───────────── Skeleton ─────────────

/** Loading placeholder. `lines` renders a paragraph of bars of varying width. */
export function Skeleton({
  width,
  height = 12,
  radius,
  lines,
  className,
}: {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  lines?: number;
  className?: string;
}) {
  if (lines)
    return (
      <div className={`skeleton-lines ${className ?? ''}`} aria-hidden="true">
        {Array.from({ length: lines }, (_, i) => (
          <span key={i} className="skeleton" style={{ height, width: i === lines - 1 ? '62%' : `${92 - ((i * 13) % 20)}%` }} />
        ))}
      </div>
    );
  return <span className={`skeleton ${className ?? ''}`} aria-hidden="true" style={{ width, height, borderRadius: radius }} />;
}

/** Skeleton of a list of rows (tasks, pages). */
export function SkeletonList({ rows = 6 }: { rows?: number }) {
  return (
    <div className="skeleton-list" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton-row">
          <Skeleton width={18} height={18} radius="50%" />
          <Skeleton width={`${70 - ((i * 17) % 35)}%`} height={12} />
        </div>
      ))}
    </div>
  );
}
