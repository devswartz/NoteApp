// Draw mode and the pen tools' state, remembered per device (localStorage), like Notability's pen
// settings. The ribbon's Draw toggle (src/editor/Toolbar.tsx, src/ink/InkRibbon.tsx) switches a
// canvas page between typing (draw mode off: the normal canvas, no pen behaviour at all) and
// drawing (draw mode on: the whole canvas is ink, the text boxes are inert). `tool` is the tool in
// effect: 'select' in type mode, otherwise the pen tool last picked (`penTool`).
import { create } from 'zustand';
import { TOOL, packColor } from './engine.ts';

export type InkToolName = 'select' | 'pen' | 'highlighter' | 'eraser' | 'partialEraser';
export type PenToolName = Exclude<InkToolName, 'select'>;
export const PEN_TOOLS: PenToolName[] = ['pen', 'highlighter', 'eraser', 'partialEraser'];

export interface InkColor {
  name: string;
  /** #rrggbb */
  hex: string;
}

/** Pen colours. The first is "ink": drawn light in the dark theme (render.ts), printed as stored. */
export const PEN_COLORS: InkColor[] = [
  { name: 'Black', hex: '#1f2328' },
  { name: 'Blue', hex: '#1d4ed8' },
  { name: 'Red', hex: '#dc2626' },
  { name: 'Green', hex: '#15803d' },
  { name: 'Purple', hex: '#7e22ce' },
];
export const HIGHLIGHTER_COLORS: InkColor[] = [
  { name: 'Yellow', hex: '#facc15' },
  { name: 'Green', hex: '#4ade80' },
  { name: 'Blue', hex: '#60a5fa' },
  { name: 'Pink', hex: '#f472b6' },
];
/** Base widths (page px at pressure 0.5). */
export const PEN_WIDTHS = [1.5, 2.5, 4];
export const HIGHLIGHTER_WIDTHS = [12, 18, 26];
export const ERASER_RADIUS = 8;
/** Highlighters are see-through. */
export const HIGHLIGHTER_ALPHA = 0.35;

export interface InkToolState {
  /** The tool in effect: 'select' unless draw mode is on. */
  tool: InkToolName;
  /** Draw mode (the ribbon's Draw toggle). */
  drawMode: boolean;
  /** The pen tool draw mode uses (the last one picked). */
  penTool: PenToolName;
  penColor: number;
  penWidth: number;
  highlighterColor: number;
  highlighterWidth: number;
  /** A finger draws too (off by default: it scrolls; docs/PLAN_INK.md "Decided"). */
  fingerDrawing: boolean;
  /** iPad: in type mode, a Pencil touch on the page turns draw mode on (and draws), as in OneNote. On by default. */
  pencilSwitches: boolean;
}

const KEY = 'noteapp.ink.tool';
const DEFAULTS: InkToolState = {
  tool: 'select',
  drawMode: false,
  penTool: 'pen',
  penColor: packColor(PEN_COLORS[0]!.hex),
  penWidth: PEN_WIDTHS[1]!,
  highlighterColor: packColor(HIGHLIGHTER_COLORS[0]!.hex, HIGHLIGHTER_ALPHA),
  highlighterWidth: HIGHLIGHTER_WIDTHS[1]!,
  fingerDrawing: false,
  pencilSwitches: true,
};

function load(): InkToolState {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as Partial<InkToolState>) : {};
    const s = { ...DEFAULTS, ...v };
    if (!PEN_TOOLS.includes(s.penTool)) s.penTool = 'pen';
    return { ...s, tool: s.drawMode ? s.penTool : 'select' };
  } catch {
    return DEFAULTS;
  }
}

export const useInkTool = create<InkToolState>(() => load());

export function setInkTool(patch: Partial<InkToolState>) {
  // A pen tool is remembered for draw mode, and only applies in it.
  if (patch.tool && patch.tool !== 'select') {
    patch = { ...patch, penTool: patch.tool };
    if (!(patch.drawMode ?? useInkTool.getState().drawMode)) delete patch.tool;
  }
  useInkTool.setState(patch);
  try {
    const { tool: _t, ...keep } = useInkTool.getState();
    globalThis.localStorage?.setItem(KEY, JSON.stringify(keep));
  } catch {
    // not remembered: fine
  }
}

/** Draw mode on (the pen tool last used) or off (typing). */
export function setDrawMode(on: boolean) {
  const s = useInkTool.getState();
  setInkTool({ drawMode: on, tool: on ? s.penTool : 'select' });
}

/** Whether the open page offers ink (the `ink` flag, an editable canvas page, not the stacked phone layout): CanvasEditor sets it. */
export const useInkAvailable = create<{ available: boolean }>(() => ({ available: false }));

/** The style a new stroke gets from the toolbar (null for tools that don't draw). */
export function strokeStyle(s: InkToolState): { tool: number; color: number; width: number } | null {
  if (s.tool === 'pen') return { tool: TOOL.pen, color: s.penColor, width: s.penWidth };
  if (s.tool === 'highlighter') return { tool: TOOL.highlighter, color: s.highlighterColor, width: s.highlighterWidth };
  return null;
}
