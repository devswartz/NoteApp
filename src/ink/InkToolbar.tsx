// The pen toolbar on canvas pages (behind the `ink` flag, src/lib/flags.ts): select (type and move
// boxes), pen, highlighter, stroke eraser, partial eraser, a few colours and widths, and finger
// drawing (off by default).
import { Eraser, Hand, Highlighter, MousePointer2, Pen, Slice } from 'lucide-react';
import { packColor } from './engine.ts';
import { HIGHLIGHTER_ALPHA, HIGHLIGHTER_COLORS, HIGHLIGHTER_WIDTHS, PEN_COLORS, PEN_WIDTHS, setInkTool, useInkTool, type InkToolName } from './inkTool.ts';
import '../styles/ink.css';

const TOOLS: { id: InkToolName; label: string; Icon: typeof Pen }[] = [
  { id: 'select', label: 'Select and type', Icon: MousePointer2 },
  { id: 'pen', label: 'Pen', Icon: Pen },
  { id: 'highlighter', label: 'Highlighter', Icon: Highlighter },
  { id: 'eraser', label: 'Eraser (whole strokes)', Icon: Eraser },
  { id: 'partialEraser', label: 'Partial eraser', Icon: Slice },
];

export function InkToolbar() {
  const s = useInkTool();
  const hl = s.tool === 'highlighter';
  const colors = hl ? HIGHLIGHTER_COLORS : PEN_COLORS;
  const widths = hl ? HIGHLIGHTER_WIDTHS : PEN_WIDTHS;
  const color = hl ? s.highlighterColor : s.penColor;
  const width = hl ? s.highlighterWidth : s.penWidth;
  const drawing = s.tool === 'pen' || hl;
  return (
    <div className="ink-toolbar" role="toolbar" aria-label="Pen tools" data-testid="ink-toolbar">
      {TOOLS.map(({ id, label, Icon }) => (
        <button key={id} type="button" className={`btn-ghost icon-btn ${s.tool === id ? 'is-active' : ''}`} aria-pressed={s.tool === id} title={label} aria-label={label} onClick={() => setInkTool({ tool: id })}>
          <Icon size={16} />
        </button>
      ))}
      {drawing && (
        <>
          <span className="ink-sep" aria-hidden />
          {colors.map((c) => {
            const v = packColor(c.hex, hl ? HIGHLIGHTER_ALPHA : 1);
            return (
              <button
                key={c.hex}
                type="button"
                className={`ink-swatch ${color === v ? 'is-active' : ''}`}
                style={{ background: c.hex }}
                aria-pressed={color === v}
                title={c.name}
                aria-label={c.name}
                onClick={() => setInkTool(hl ? { highlighterColor: v } : { penColor: v })}
              />
            );
          })}
          <span className="ink-sep" aria-hidden />
          {widths.map((w, i) => (
            <button
              key={w}
              type="button"
              className={`btn-ghost icon-btn ink-width ${width === w ? 'is-active' : ''}`}
              aria-pressed={width === w}
              title={['Fine', 'Medium', 'Thick'][i]}
              aria-label={['Fine', 'Medium', 'Thick'][i]}
              onClick={() => setInkTool(hl ? { highlighterWidth: w } : { penWidth: w })}
            >
              <span style={{ width: 4 + i * 4, height: 4 + i * 4 }} />
            </button>
          ))}
        </>
      )}
      <span className="ink-sep" aria-hidden />
      <button
        type="button"
        className={`btn-ghost icon-btn ${s.fingerDrawing ? 'is-active' : ''}`}
        aria-pressed={s.fingerDrawing}
        title={s.fingerDrawing ? 'Finger drawing is on (a finger draws)' : 'Finger drawing is off (a finger scrolls)'}
        aria-label="Draw with a finger"
        onClick={() => setInkTool({ fingerDrawing: !s.fingerDrawing })}
      >
        <Hand size={16} />
      </button>
    </div>
  );
}
