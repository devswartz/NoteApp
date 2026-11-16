// The ink layer of a canvas page (docs/PLAN_INK.md, phase I1): draws the page's strokes (render.ts)
// and, with an ink tool active, turns pointer input into strokes and erasing. CanvasEditor's pointer
// router decides which pointers come here (src/editor/canvasGeom.ts routePointer); this file only
// handles what it is given.
//
// Input: coalesced events give every sample the pen reported between frames, predicted events let
// the live stroke reach ahead of the pen, and where the browser offers it (Edge/WebView2 on
// Windows) the OS draws the newest part of the stroke itself (navigator.ink delegated ink trail).
// A stroke is drawn locally while the pen is down and written to the page doc in one transaction
// when it lifts; an erase gesture likewise.
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import type * as Y from 'yjs';
import { INK_KEY } from '../../shared/pageDoc.ts';
import { canvasView, toPage } from '../editor/canvasGeom.ts';
import { FLAG, loadInk, type InkEngine, type StrokeBuilder } from './engine.ts';
import { ERASER_RADIUS, strokeStyle, useInkTool, type InkToolName } from './inkTool.ts';
import { InkRenderer } from './render.ts';
import { EraseSession, commitStroke, topZ, zAfter } from './strokes.ts';

/** What CanvasEditor calls when its router hands a pointer to ink. */
export interface InkHandle {
  /** Take this pointer (already routed to ink). False when ink can't take it yet (the engine is loading). */
  pointerDown(e: PointerEvent, tool: InkToolName): boolean;
}

interface Props {
  doc: Y.Doc;
  /** The canvas surface the strokes are drawn on (page px = surface px at scale 1). */
  surface: React.RefObject<HTMLDivElement | null>;
  /** Whether to load the engine even if the page has no ink yet (a pen tool is active). */
  wanted: boolean;
  /** Around each write: CanvasEditor ends the undo capture so every stroke is its own step. */
  onWrite?: () => void;
  /** How far the ink reaches, right and down (page px), whenever it changes. */
  onExtent?: (e: { w: number; h: number }) => void;
  ref?: Ref<InkHandle>;
}

// Delegated ink trail (Edge/WebView2): typed loosely, it isn't in TypeScript's DOM types.
interface InkPresenter {
  updateInkTrailStartPoint(e: PointerEvent, style: { color: string; diameter: number }): void;
}
type InkNavigator = Navigator & { ink?: { requestPresenter(opts?: { presentationArea?: Element }): Promise<InkPresenter> } };

/** A pointer sample: page px plus pressure and tilt. */
function sample(e: PointerEvent, rect: DOMRect): [number, number, number, number, number, number] {
  const p = toPage(canvasView(rect), e.clientX, e.clientY);
  const pen = e.pointerType === 'pen';
  const alt = typeof e.altitudeAngle === 'number' ? e.altitudeAngle : Math.PI / 2;
  const az = typeof e.azimuthAngle === 'number' ? e.azimuthAngle : 0;
  // A pen touching the screen with 0 pressure (some report 0 on the first sample): treat as light.
  const pressure = pen ? (e.pressure > 0 ? e.pressure : 0.2) : 0.5;
  return [p.x, p.y, pressure, alt, az, e.timeStamp];
}

export function InkSurface({ doc, surface, wanted, onWrite, onExtent, ref }: Props) {
  const under = useRef<HTMLCanvasElement>(null);
  const over = useRef<HTMLCanvasElement>(null);
  const live = useRef<HTMLCanvasElement>(null);
  const [engine, setEngine] = useState<InkEngine | null>(null);
  const renderer = useRef<InkRenderer | null>(null);
  const presenter = useRef<Promise<InkPresenter | null> | null>(null);
  const onWriteRef = useRef(onWrite);
  onWriteRef.current = onWrite;

  // Load the engine when the page has ink or a pen tool is picked; until then nothing is downloaded.
  const [hasInk, setHasInk] = useState(() => doc.getMap(INK_KEY).size > 0);
  useEffect(() => {
    const map = doc.getMap(INK_KEY);
    const on = () => setHasInk(map.size > 0);
    on();
    map.observe(on);
    return () => map.unobserve(on);
  }, [doc]);
  useEffect(() => {
    if (engine || !(hasInk || wanted)) return;
    let live = true;
    loadInk().then(
      (e) => live && setEngine(e),
      (err) => console.warn('ink engine failed to load', err),
    );
    return () => {
      live = false;
    };
  }, [engine, hasInk, wanted]);

  const onExtentRef = useRef(onExtent);
  onExtentRef.current = onExtent;
  useEffect(() => {
    if (!engine) return;
    const map = doc.getMap<unknown>(INK_KEY);
    let last = '';
    const measure = () => {
      let w = 0;
      let h = 0;
      map.forEach((v) => {
        const b = v instanceof Uint8Array ? engine.info(v)?.bounds : null;
        if (b && b.maxX >= b.minX) {
          w = Math.max(w, Math.ceil(b.maxX));
          h = Math.max(h, Math.ceil(b.maxY));
        }
      });
      if (`${w},${h}` !== last) {
        last = `${w},${h}`;
        onExtentRef.current?.({ w, h });
      }
    };
    measure();
    map.observe(measure);
    return () => map.unobserve(measure);
  }, [engine, doc]);

  useEffect(() => {
    const s = surface.current;
    if (!engine || !s || !under.current || !over.current || !live.current) return;
    const r = new InkRenderer(engine, doc, s, { under: under.current, over: over.current, live: live.current });
    renderer.current = r;
    return () => {
      r.destroy();
      renderer.current = null;
    };
  }, [engine, doc, surface]);

  useImperativeHandle(
    ref,
    () => ({
      pointerDown(e: PointerEvent, tool: InkToolName) {
        const r = renderer.current;
        const el = surface.current;
        if (!engine || !r || !el || tool === 'select') return false;
        e.preventDefault(); // no text selection, no box created, no mouse events after it
        e.stopPropagation();
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          // a synthetic or already-released pointer: moves still arrive while it's down
        }
        if (tool === 'eraser' || tool === 'partialEraser') eraseGesture(e, el, engine, r, doc, tool === 'partialEraser', () => onWriteRef.current?.());
        else strokeGesture(e, el, engine, r, doc, presenter, () => onWriteRef.current?.());
        return true;
      },
    }),
    [engine, doc, surface],
  );

  return (
    <>
      <canvas ref={under} className="ink-layer ink-under" aria-hidden data-testid="ink-under" />
      <canvas ref={over} className="ink-layer ink-over" aria-hidden data-testid="ink-over" />
      <canvas ref={live} className="ink-layer ink-live" aria-hidden />
    </>
  );
}

/** Follow one pointer until it lifts (or is cancelled). `move` gets every sample, coalesced ones included. */
function follow(el: HTMLElement, first: PointerEvent, move: (samples: PointerEvent[], predicted: PointerEvent[], e: PointerEvent) => void, end: (cancelled: boolean) => void) {
  const id = first.pointerId;
  const onMove = (e: PointerEvent) => {
    if (e.pointerId !== id) return;
    e.preventDefault();
    const coalesced = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    const predicted = typeof e.getPredictedEvents === 'function' ? e.getPredictedEvents() : [];
    move(coalesced.length ? coalesced : [e], predicted, e);
  };
  const done = (e: PointerEvent) => {
    if (e.pointerId !== id) return;
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', done);
    el.removeEventListener('pointercancel', done);
    try {
      el.releasePointerCapture(id);
    } catch {
      // already released
    }
    end(e.type === 'pointercancel');
  };
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', done);
  el.addEventListener('pointercancel', done);
}

function strokeGesture(first: PointerEvent, el: HTMLElement, engine: InkEngine, r: InkRenderer, doc: Y.Doc, presenter: { current: Promise<InkPresenter | null> | null }, onWrite: () => void) {
  const style = strokeStyle(useInkTool.getState());
  if (!style) return;
  const pen = first.pointerType === 'pen';
  const flags = pen ? FLAG.pressure | (typeof first.altitudeAngle === 'number' ? FLAG.tilt : 0) : 0;
  const b: StrokeBuilder = engine.builder({ ...style, z: zAfter(topZ(r.zKeys(style.tool))), flags });
  let rect = el.getBoundingClientRect();
  b.push(...sample(first, rect));
  let predicted: number[] = [];
  let frame = 0;
  const draw = () => {
    frame = 0;
    r.drawLive(b.preview(predicted), style.color, style.tool);
  };
  const later = () => (frame ||= requestAnimationFrame(draw));
  later();

  // Windows: the OS draws the newest bit of the stroke ahead of the page (we draw the rest).
  const nav = navigator as InkNavigator;
  if (nav.ink && pen) {
    const live = el.querySelector<HTMLCanvasElement>('canvas.ink-live');
    presenter.current ??= nav.ink.requestPresenter(live ? { presentationArea: live } : undefined).catch(() => null);
  }
  const trail = pen && nav.ink ? presenter.current : null;
  const diameter = style.width;

  follow(
    el,
    first,
    (samples, pred, e) => {
      rect = el.getBoundingClientRect();
      for (const s of samples) b.push(...sample(s, rect));
      predicted = pred.flatMap((p) => sample(p, rect).slice(0, 3));
      trail?.then((p) => p?.updateInkTrailStartPoint(e, { color: cssTrail(style.color), diameter }));
      later();
    },
    (cancelled) => {
      cancelAnimationFrame(frame);
      const blob = cancelled ? (b.cancel(), null) : b.finish();
      if (blob) {
        onWrite();
        commitStroke(doc, blob);
        onWrite();
      }
      // Cleared on the frame the committed stroke is first painted (the renderer's frame runs first), so it never blinks.
      requestAnimationFrame(() => r.drawLive(null));
    },
  );
}

/** The trail's colour: opaque (the OS draws it on top). */
function cssTrail(c: number): string {
  return `rgb(${(c >>> 24) & 255} ${(c >>> 16) & 255} ${(c >>> 8) & 255})`;
}

function eraseGesture(first: PointerEvent, el: HTMLElement, engine: InkEngine, r: InkRenderer, doc: Y.Doc, partial: boolean, onWrite: () => void) {
  const session = new EraseSession();
  let rect = el.getBoundingClientRect();
  let last = sample(first, rect);
  const rad = ERASER_RADIUS;
  const apply = (track: number[]) => {
    const xs = track.filter((_, i) => i % 2 === 0);
    const ys = track.filter((_, i) => i % 2 === 1);
    const box = { minX: Math.min(...xs) - rad, minY: Math.min(...ys) - rad, maxX: Math.max(...xs) + rad, maxY: Math.max(...ys) + rad };
    let changed = false;
    for (const [id, blob] of session.visible(r.strokes())) {
      const info = session.added.has(id) ? engine.info(blob) : r.info(id);
      const b = info?.bounds;
      if (!b || b.minX > box.maxX || box.minX > b.maxX || b.minY > box.maxY || box.minY > b.maxY) continue;
      if (partial) {
        const pieces = engine.erase(blob, track, rad);
        if (pieces) {
          session.replace(id, pieces);
          changed = true;
        }
      } else if (engine.hitPath(blob, track, rad)) {
        session.replace(id);
        changed = true;
      }
    }
    if (changed) r.setOverlay(session.removed, session.added);
  };
  apply([last[0], last[1]]);
  follow(
    el,
    first,
    (samples) => {
      rect = el.getBoundingClientRect();
      const track = [last[0], last[1]];
      for (const s of samples) {
        last = sample(s, rect);
        track.push(last[0], last[1]);
      }
      apply(track);
    },
    (cancelled) => {
      if (!cancelled && session.changed) {
        onWrite();
        session.commit(doc);
        onWrite();
      }
      r.setOverlay(new Set(), new Map());
    },
  );
}
