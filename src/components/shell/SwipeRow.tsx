// Swipe actions for list rows on touch screens (Mail/Todoist style).
//
//   <SwipeRow
//     right={{ label: 'Complete', icon: <Check />, tone: 'success', onTrigger: () => toggleTask(id) }}
//     left={{ label: 'Tomorrow', icon: <CalendarClock />, tone: 'accent', onTrigger: () => reschedule(id) }}
//   >
//     <TaskRow … />
//   </SwipeRow>
//
// `right` is revealed by swiping right (finger moves →), `left` by swiping left.
// Swiping past the threshold and releasing triggers the action. Mouse and pen
// are ignored (desktop keeps hover menus), and vertical scrolling always wins
// over a swipe. The actions must also be reachable another way (menu,
// checkbox), because swipes are invisible to keyboard and screen-reader users.
import { useRef, useState, type ReactNode } from 'react';

export interface SwipeAction {
  label: string;
  icon?: ReactNode;
  tone?: 'success' | 'accent' | 'warn' | 'danger';
  onTrigger: () => void;
}

const THRESHOLD = 0.32; // fraction of the row width that commits the action
const MAX = 0.85;

export function SwipeRow({ left, right, children, disabled }: { left?: SwipeAction; right?: SwipeAction; children: ReactNode; disabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const g = useRef<{ x: number; y: number; w: number; id: number; locked: boolean | null } | null>(null);
  const [dx, setDx] = useState(0);
  const [settling, setSettling] = useState(false);

  if (disabled || (!left && !right)) return <>{children}</>;

  const action = dx > 0 ? right : dx < 0 ? left : undefined;
  const w = ref.current?.offsetWidth ?? 1;
  const armed = Math.abs(dx) > w * THRESHOLD;

  const reset = () => {
    setSettling(true);
    setDx(0);
    window.setTimeout(() => setSettling(false), 200);
  };

  return (
    <div
      ref={ref}
      className={`swipe-row ${dx ? 'is-swiping' : ''}`}
      onPointerDown={(e) => {
        if (e.pointerType !== 'touch' || settling) return;
        g.current = { x: e.clientX, y: e.clientY, w: e.currentTarget.offsetWidth, id: e.pointerId, locked: null };
      }}
      onPointerMove={(e) => {
        const s = g.current;
        if (!s || e.pointerId !== s.id) return;
        const mx = e.clientX - s.x;
        const my = e.clientY - s.y;
        if (s.locked === null) {
          if (Math.abs(mx) < 10 && Math.abs(my) < 10) return;
          s.locked = Math.abs(mx) > Math.abs(my) * 1.2;
          if (!s.locked) return void (g.current = null);
          e.currentTarget.setPointerCapture(e.pointerId);
        }
        let next = mx;
        if (next > 0 && !right) next = 0;
        if (next < 0 && !left) next = 0;
        setDx(Math.max(-s.w * MAX, Math.min(s.w * MAX, next)));
      }}
      onPointerUp={() => {
        const s = g.current;
        g.current = null;
        if (!s?.locked) return;
        if (armed && action) {
          // Slide out, then fire and spring back (the row usually re-renders or disappears).
          setSettling(true);
          setDx(dx > 0 ? s.w : -s.w);
          window.setTimeout(() => {
            action.onTrigger();
            setDx(0);
            window.setTimeout(() => setSettling(false), 200);
          }, 160);
        } else reset();
      }}
      onPointerCancel={() => {
        g.current = null;
        reset();
      }}
      onClickCapture={(e) => {
        // A swipe shouldn't also count as a tap on the row.
        if (dx !== 0) (e.preventDefault(), e.stopPropagation());
      }}
    >
      {action && (
        <div className={`swipe-action tone-${action.tone ?? 'accent'} ${dx > 0 ? 'from-left' : 'from-right'} ${armed ? 'is-armed' : ''}`} aria-hidden="true">
          {action.icon}
          <span>{action.label}</span>
        </div>
      )}
      <div className={`swipe-content ${settling ? 'is-settling' : ''}`} style={dx ? { transform: `translateX(${dx}px)` } : undefined}>
        {children}
      </div>
    </div>
  );
}
