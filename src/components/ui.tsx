import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  createContext,
  useContext,
} from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';
import { initials } from '../lib/format.ts';

// ───────────── Popover ─────────────

const PopoverCtx = createContext<() => void>(() => {});
export const useClosePopover = () => useContext(PopoverCtx);

interface PopoverProps {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  placement?: 'bottom-start' | 'bottom-end' | 'top-start';
  className?: string;
}

/** Floating panel anchored to an element; closes on outside click and Escape. */
export function Popover({ anchor, open, onClose, children, placement = 'bottom-start', className }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !anchor.current || !ref.current) return;
    const a = anchor.current.getBoundingClientRect();
    const p = ref.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = placement === 'bottom-end' ? a.right - p.width : a.left;
    let top = placement === 'top-start' ? a.top - p.height - 6 : a.bottom + 6;
    if (top + p.height > vh - 8) top = Math.max(8, a.top - p.height - 6);
    left = Math.min(Math.max(8, left), vw - p.width - 8);
    setPos({ top, left });
  }, [open, anchor, placement]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, onClose, anchor]);

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

// ───────────── Modal ─────────────

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
      <div className={`modal ${className ?? ''}`} role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </div>
    </div>,
    document.body,
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
