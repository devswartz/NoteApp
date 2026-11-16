// The pen toolbar's state: which tool is active, its colour and width, and whether a finger
// draws. Remembered per device (localStorage), like Notability's pen settings.
import { create } from 'zustand';
import { TOOL, packColor } from './engine.ts';

export type InkToolName = 'select' | 'pen' | 'highlighter' | 'eraser' | 'partialEraser';

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
  tool: InkToolName;
  penColor: number;
  penWidth: number;
  highlighterColor: number;
  highlighterWidth: number;
  /** A finger draws too (off by default: it scrolls; docs/PLAN_INK.md "Decided"). */
  fingerDrawing: boolean;
}

const KEY = 'noteapp.ink.tool';
const DEFAULTS: InkToolState = {
  tool: 'select',
  penColor: packColor(PEN_COLORS[0]!.hex),
  penWidth: PEN_WIDTHS[1]!,
  highlighterColor: packColor(HIGHLIGHTER_COLORS[0]!.hex, HIGHLIGHTER_ALPHA),
  highlighterWidth: HIGHLIGHTER_WIDTHS[1]!,
  fingerDrawing: false,
};

function load(): InkToolState {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as Partial<InkToolState>) : {};
    // The tool itself isn't remembered: a page opens ready to type.
    return { ...DEFAULTS, ...v, tool: 'select' };
  } catch {
    return DEFAULTS;
  }
}

export const useInkTool = create<InkToolState>(() => load());

export function setInkTool(patch: Partial<InkToolState>) {
  useInkTool.setState(patch);
  try {
    const { tool: _t, ...keep } = useInkTool.getState();
    globalThis.localStorage?.setItem(KEY, JSON.stringify(keep));
  } catch {
    // not remembered: fine
  }
}

/** The style a new stroke gets from the toolbar (null for tools that don't draw). */
export function strokeStyle(s: InkToolState): { tool: number; color: number; width: number } | null {
  if (s.tool === 'pen') return { tool: TOOL.pen, color: s.penColor, width: s.penWidth };
  if (s.tool === 'highlighter') return { tool: TOOL.highlighter, color: s.highlighterColor, width: s.highlighterWidth };
  return null;
}
