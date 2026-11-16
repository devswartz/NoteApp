// The bridge to the iPad's native pen layer (docs/PLAN_INK.md, phase I2; the native side is
// apps/mobile/ios/App/App/NoteAppInkPlugin.swift and the NvInk package). On an iPad with the
// `ink` flag, a canvas page's ink is drawn natively, inside WebKit's own scroll view for the page,
// so ink and text pan together in the same frame; native code also owns pinch zoom.
//
// The page doc stays the one source of truth, and the web writes it with the same code as the web
// pen (strokes.ts commitStroke / commitErase, INK_ORIGIN), so sync, undo and print just work:
//   native → web: a finished stroke (once per stroke, never per point), an erase gesture, a new
//                 view after a pinch (zoom + scroll: the web applies it, then says viewApplied),
//                 Pencil double-tap's tool, two-finger-tap undo and three-finger-tap redo (as in
//                 Notability; anywhere on the page, whatever tool is picked).
//   web → native: every stroke on the page at start, then each change to the `ink` map (remote
//                 strokes, undo, our own commits), the tool, and where the page is (layout).
// A change made natively carries a token; the update that writes it carries the token back, so the
// native layer swaps its provisional drawing for the real stroke in the same frame.
// No DOM and no Capacitor here (they're passed in), so it is unit-tested in tests/nativeInk.test.ts.
import type * as Y from 'yjs';
import { create } from 'zustand';
import { INK_KEY } from '../../shared/pageDoc.ts';
import type { InkToolName } from './inkTool.ts';
import { commitErase, commitStroke } from './strokes.ts';

export interface InkRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where the page is, as the native side needs it (CSS px = iOS points). */
export interface NativeInkLayout {
  /** The page's scroller (its visible box) in viewport coordinates. */
  scroller: InkRect;
  /** The canvas surface: x, y in the scroller's content coordinates (zoom doesn't move it); w, h in page px. */
  surface: InkRect;
  zoom: number;
  /** Viewport areas over the page where the pen must not draw (sticky bars, the pen toolbar). */
  exclusions: InkRect[];
}

export interface NativeInkTool {
  tool: InkToolName;
  /** 0xRRGGBBAA */
  color: number;
  width: number;
  fingerDrawing: boolean;
  /** The pen tool draw mode uses: a Pencil touch in type mode switches to it (with pencilSwitches). */
  penTool: InkToolName;
  /** In type mode a Pencil touch turns draw mode on, and that stroke draws. */
  pencilSwitches: boolean;
  eraserRadius: number;
  dark: boolean;
}

export interface WireStroke {
  id: string;
  /** The blob, base64. */
  data: string;
}

export interface NativeView {
  zoom: number;
  /** The scroller's scroll offset. */
  x: number;
  y: number;
  /** After a pinch: apply it, then the session tells native (viewApplied). Otherwise a report. */
  final: boolean;
}

export interface NativeInkEvents {
  stroke: { token: string; data: string };
  erase: { token: string; removed: string[]; added: string[] };
  view: NativeView;
  /** The Pencil changed the tool: double-tap (eraser), or `enterDraw` when a Pencil touch in type mode turned draw mode on. */
  tool: { tool: InkToolName; enterDraw?: boolean };
  undo: Record<string, never>;
  redo: Record<string, never>;
  detached: Record<string, never>;
}

export interface Listener {
  remove(): Promise<void> | void;
}

/** The NoteAppInk plugin (registerPlugin('NoteAppInk')), or a fake in tests. */
export interface NativeInkPlugin {
  available(): Promise<{ available: boolean; pencilKit?: boolean }>;
  /** `detail`: why it didn't attach (the scroll views it saw), for the status readout. */
  attach(l: NativeInkLayout): Promise<{ attached: boolean; detail?: string }>;
  layout(l: NativeInkLayout): Promise<{ attached: boolean }>;
  detach(): Promise<void>;
  setTool(t: NativeInkTool): Promise<void>;
  setStrokes(o: { strokes: WireStroke[] }): Promise<void>;
  updateStrokes(o: { added: WireStroke[]; removed: string[]; ack?: string }): Promise<void>;
  viewApplied(o: { zoom: number }): Promise<void>;
  setRenderer(o: { renderer: 'notivelo' | 'pencilkit' }): Promise<{ renderer: string }>;
  addListener<K extends keyof NativeInkEvents>(event: K, fn: (e: NativeInkEvents[K]) => void): Promise<Listener> | Listener;
}

// ───────────── base64 (the bridge is JSON) ─────────────

export function toBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ───────────── finding the plugin ─────────────

let found: Promise<NativeInkPlugin | null> | null = null;

/**
 * The native pen layer when this is the iPad app (null everywhere else: web, desktop, iPhone,
 * Android, or an app build without the plugin). `load` is for tests.
 */
export function nativeInkPlugin(load?: () => Promise<NativeInkPlugin | null>): Promise<NativeInkPlugin | null> {
  if (load) return (found = load().then(check, () => null));
  return (found ??= realPlugin().then(check, () => null));
}

async function check(p: NativeInkPlugin | null): Promise<NativeInkPlugin | null> {
  if (!p) {
    setStatus('web pen (not the iOS app)');
    return null;
  }
  const a = await p.available().then(
    (r) => r,
    () => null,
  );
  if (!a) setStatus('web pen (the app has no NoteAppInk plugin)');
  else if (!a.available) setStatus('web pen (not an iPad)');
  return a?.available ? p : null;
}

async function realPlugin(): Promise<NativeInkPlugin | null> {
  const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string; isPluginAvailable?: (n: string) => boolean } }).Capacitor;
  if (!cap?.isNativePlatform?.() || cap.getPlatform?.() !== 'ios') return null;
  const core = await import('@capacitor/core');
  return core.registerPlugin<NativeInkPlugin>('NoteAppInk');
}

// ───────────── debug switches (the pen toolbar's hidden debug menu) ─────────────

export interface NativeInkDebug {
  /** The native pen layer is in use on this page. */
  active: boolean;
  /** What the native pen layer is doing, in words (the status readout on the iPad). */
  status: string;
  renderer: 'notivelo' | 'pencilkit';
  /** Also draw the web's own ink (faint) under the native ink: they should line up exactly. */
  webOverlay: boolean;
  /** Set by the page while the native layer is in use. */
  setRenderer: ((r: 'notivelo' | 'pencilkit') => void) | null;
  /** Fill the page with test strokes and boxes. */
  fill: (() => void) | null;
}

export const useNativeInkDebug = create<NativeInkDebug>(() => ({ active: false, status: 'checking', renderer: 'notivelo', webOverlay: false, setRenderer: null, fill: null }));

const setStatus = (status: string) => useNativeInkDebug.setState({ status });

/** Waits between attempts to attach (ms): WebKit makes the page's scroll view a moment after layout. */
export const ATTACH_RETRY_MS = [0, 100, 250, 500, 1000, 2000, 4000];

// ───────────── the session ─────────────

export interface NativeInkSessionOptions {
  /** Around each write: the caller ends the undo capture so every stroke is its own step. */
  onWrite?: () => void;
  /** Apply a view from native (zoom and scroll). For a final one, resolve once it's laid out. */
  onView?: (v: NativeView) => Promise<void> | void;
  onTool?: (tool: InkToolName, enterDraw: boolean) => void;
  onUndo?: () => void;
  /** Three-finger tap: redo. */
  onRedo?: () => void;
  /** What the session is doing, in words (the status readout). */
  onStatus?: (status: string) => void;
  /** Native lost the page (its scroll view): the caller falls back to the web pen. */
  onDetached?: () => void;
}

/** One page's link to the native pen layer, from start() to stop(). */
export class NativeInkSession {
  private readonly map: Y.Map<unknown>;
  private listeners: Listener[] = [];
  private pendingAck: string | null = null;
  private stopped = false;
  private readonly observer = (e: Y.YMapEvent<unknown>) => this.changed(e);

  constructor(
    private readonly plugin: NativeInkPlugin,
    private readonly doc: Y.Doc,
    private readonly opts: NativeInkSessionOptions = {},
  ) {
    this.map = doc.getMap<unknown>(INK_KEY);
  }

  /**
   * Attach to the page and send it every stroke. WebKit makes its native scroll view for the page
   * a moment after layout, so this tries a few times (ATTACH_RETRY_MS), measuring the page again
   * each time. False when native can't attach (the web pen stays).
   */
  async start(layout: NativeInkLayout | (() => NativeInkLayout | null), tool: NativeInkTool, waits: number[] = ATTACH_RETRY_MS): Promise<boolean> {
    let attached = false;
    let detail = '';
    for (const [i, ms] of waits.entries()) {
      if (ms) await new Promise((r) => setTimeout(r, ms));
      if (this.stopped) return false;
      const l = typeof layout === 'function' ? layout() : layout;
      if (!l) continue;
      this.opts.onStatus?.(`attaching (try ${i + 1})`);
      const r = await this.plugin.attach(l).catch((e: unknown) => ({ attached: false, detail: String(e) }));
      attached = r.attached;
      detail = r.detail ?? '';
      if (attached) break;
    }
    if (!attached) this.opts.onStatus?.(`web pen: native layer didn't attach${detail ? ` (${detail})` : ''}`);
    if (!attached || this.stopped) return false;
    this.opts.onStatus?.('native layer attached');
    const on = async <K extends keyof NativeInkEvents>(k: K, fn: (e: NativeInkEvents[K]) => void) => {
      const l = await this.plugin.addListener(k, (e) => {
        if (!this.stopped) fn(e);
      });
      if (this.stopped) void l.remove();
      else this.listeners.push(l);
    };
    await Promise.all([
      on('stroke', (e) => this.stroke(e)),
      on('erase', (e) => this.erase(e)),
      on('view', (e) => void this.view(e)),
      on('tool', (e) => this.opts.onTool?.(e.tool, !!e.enterDraw)),
      on('undo', () => this.opts.onUndo?.()),
      on('redo', () => this.opts.onRedo?.()),
      on('detached', () => this.opts.onDetached?.()),
    ]);
    await this.plugin.setTool(tool);
    const strokes: WireStroke[] = [];
    this.map.forEach((v, id) => {
      if (v instanceof Uint8Array) strokes.push({ id, data: toBase64(v) });
    });
    await this.plugin.setStrokes({ strokes });
    this.map.observe(this.observer);
    return true;
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.map.unobserve(this.observer);
    const ls = this.listeners;
    this.listeners = [];
    await Promise.all(ls.map((l) => l.remove()));
    await this.plugin.detach().catch(() => {});
  }

  layout(l: NativeInkLayout) {
    if (!this.stopped) void this.plugin.layout(l).catch(() => {});
  }

  setTool(t: NativeInkTool) {
    if (!this.stopped) void this.plugin.setTool(t).catch(() => {});
  }

  /** The `ink` map changed (anyone: remote strokes, undo, our own commits): tell native. */
  private changed(e: Y.YMapEvent<unknown>) {
    const added: WireStroke[] = [];
    const removed: string[] = [];
    e.changes.keys.forEach((c, id) => {
      const v = this.map.get(id);
      if (c.action !== 'delete' && v instanceof Uint8Array) added.push({ id, data: toBase64(v) });
      else removed.push(id);
    });
    const ack = this.takeAck();
    void this.plugin.updateStrokes({ added, removed, ...(ack ? { ack } : {}) }).catch(() => {});
  }

  private takeAck(): string | undefined {
    const a = this.pendingAck ?? undefined;
    this.pendingAck = null;
    return a;
  }

  /** After a native change: its token must go back even if the write changed nothing. */
  private flushAck() {
    const ack = this.takeAck();
    if (ack) void this.plugin.updateStrokes({ added: [], removed: [], ack }).catch(() => {});
  }

  private stroke(e: NativeInkEvents['stroke']) {
    this.pendingAck = e.token;
    try {
      this.opts.onWrite?.();
      commitStroke(this.doc, fromBase64(e.data));
      this.opts.onWrite?.();
    } finally {
      this.flushAck();
    }
  }

  private erase(e: NativeInkEvents['erase']) {
    this.pendingAck = e.token;
    try {
      this.opts.onWrite?.();
      commitErase(this.doc, e.removed, e.added.map(fromBase64));
      this.opts.onWrite?.();
    } finally {
      this.flushAck();
    }
  }

  private async view(v: NativeView) {
    try {
      await this.opts.onView?.(v);
    } finally {
      if (v.final && !this.stopped) await this.plugin.viewApplied({ zoom: v.zoom }).catch(() => {});
    }
  }
}

// ───────────── measuring the page ─────────────

const EXCLUDE = '.page-topbar, .ink-toolbar, .table-bar, .bubble-menu, [data-ink-exclude]';

const rectOf = (r: DOMRect): InkRect => ({ x: r.left, y: r.top, w: r.width, h: r.height });

/** The page's layout for the native side; null when the surface isn't in a page scroller. */
export function measureLayout(surface: HTMLElement, size: { w: number; h: number }, zoom: number): NativeInkLayout | null {
  const scroller = surface.closest<HTMLElement>('.page-scroll');
  if (!scroller) return null;
  const sr = scroller.getBoundingClientRect();
  const r = surface.getBoundingClientRect();
  const exclusions = [...document.querySelectorAll<HTMLElement>(EXCLUDE)]
    .map((el) => el.getBoundingClientRect())
    .filter((e) => e.width > 0 && e.height > 0 && e.right > sr.left && e.left < sr.right && e.bottom > sr.top && e.top < sr.bottom)
    .map(rectOf);
  return {
    scroller: rectOf(sr),
    surface: {
      x: r.left - sr.left - scroller.clientLeft + scroller.scrollLeft,
      y: r.top - sr.top - scroller.clientTop + scroller.scrollTop,
      w: size.w,
      h: size.h,
    },
    zoom,
    exclusions,
  };
}

/** Wait until the browser has painted what was just changed (two animation frames). */
export const painted = () => new Promise<void>((res) => requestAnimationFrame(() => requestAnimationFrame(() => res())));
