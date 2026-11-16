// The ribbon's Draw toggle and, in draw mode, the pen groups that take the place of the text
// groups (OneNote's Draw tab, done as a swap): pen, highlighter, both erasers, colours, widths,
// finger drawing, and on the iPad the pen layer's debug menu. Behind the `ink` flag; shown only
// where CanvasEditor says ink works (useInkAvailable). Buttons use the ribbon's own markup
// (data-tb-item, roving focus), so keyboard use is the same as for the text groups.
import { Bug, Eraser, Hand, Highlighter, Pen, PenLine, Slice } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Group, Sep } from '../editor/Toolbar.tsx';
import { packColor } from './engine.ts';
import { HIGHLIGHTER_ALPHA, HIGHLIGHTER_COLORS, HIGHLIGHTER_WIDTHS, PEN_COLORS, PEN_WIDTHS, setDrawMode, setInkTool, useInkAvailable, useInkTool, type PenToolName } from './inkTool.ts';
import { useNativeInkDebug } from './nativeInk.ts';
import '../styles/ink.css';

const TOOLS: { id: PenToolName; label: string; Icon: typeof Pen }[] = [
  { id: 'pen', label: 'Pen', Icon: Pen },
  { id: 'highlighter', label: 'Highlighter', Icon: Highlighter },
  { id: 'eraser', label: 'Eraser (whole strokes)', Icon: Eraser },
  { id: 'partialEraser', label: 'Partial eraser', Icon: Slice },
];

function RbButton({ label, title, active, onClick, children, className = '' }: { label: string; title?: string; active?: boolean; onClick: () => void; children: ReactNode; className?: string }) {
  return (
    <button
      type="button"
      data-tb-item
      className={`bm-btn rb-btn ${active ? 'is-active' : ''} ${className}`}
      title={title ?? label}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      tabIndex={-1}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** Whether the ribbon shows draw mode: the page offers ink and draw mode is on. */
export function useDrawing(): boolean {
  const available = useInkAvailable((s) => s.available);
  const on = useInkTool((s) => s.drawMode);
  return available && on;
}

/** The Draw toggle (a group of its own), only where ink works. */
export function DrawToggle({ separator = false }: { separator?: boolean }) {
  const available = useInkAvailable((s) => s.available);
  const on = useInkTool((s) => s.drawMode);
  if (!available) return null;
  return (
    <>
    <Group label="Mode">
      <RbButton
        label="Draw"
        title={on ? 'Draw mode is on: the Pencil and the mouse draw. Click to type again.' : 'Draw: write and draw anywhere on the page (the text boxes rest meanwhile)'}
        active={on}
        className="rb-text"
        onClick={() => setDrawMode(!on)}
      >
        <PenLine />
        <span className="rb-btn-label">Draw</span>
      </RbButton>
    </Group>
    {separator && <Sep />}
    </>
  );
}

/** The pen groups shown in draw mode instead of the text groups. */
export function InkRibbonGroups() {
  const s = useInkTool();
  const hl = s.tool === 'highlighter';
  const drawing = s.tool === 'pen' || hl;
  const colors = hl ? HIGHLIGHTER_COLORS : PEN_COLORS;
  const widths = hl ? HIGHLIGHTER_WIDTHS : PEN_WIDTHS;
  const color = hl ? s.highlighterColor : s.penColor;
  const width = hl ? s.highlighterWidth : s.penWidth;
  const debug = useNativeInkDebug();
  const [debugOpen, setDebugOpen] = useState(false);
  return (
    <>
      <Group label="Tools">
        {TOOLS.map(({ id, label, Icon }) => (
          <RbButton key={id} label={label} active={s.tool === id} onClick={() => setInkTool({ tool: id })}>
            <Icon />
          </RbButton>
        ))}
      </Group>
      {drawing && (
        <>
          <Sep />
          <Group label="Colour">
            {colors.map((c) => {
              const v = packColor(c.hex, hl ? HIGHLIGHTER_ALPHA : 1);
              return (
                <RbButton key={c.hex} label={c.name} active={color === v} className="ink-swatch-btn" onClick={() => setInkTool(hl ? { highlighterColor: v } : { penColor: v })}>
                  <span className="ink-swatch" style={{ background: c.hex }} />
                </RbButton>
              );
            })}
          </Group>
          <Sep />
          <Group label="Width">
            {widths.map((w, i) => (
              <RbButton key={w} label={['Fine', 'Medium', 'Thick'][i]!} active={width === w} className="ink-width" onClick={() => setInkTool(hl ? { highlighterWidth: w } : { penWidth: w })}>
                <span style={{ width: 4 + i * 4, height: 4 + i * 4 }} />
              </RbButton>
            ))}
          </Group>
        </>
      )}
      <Sep />
      <Group label="Touch">
        <RbButton
          label="Draw with a finger"
          title={s.fingerDrawing ? 'Finger drawing is on (a finger draws; two fingers scroll)' : 'Finger drawing is off (a finger scrolls)'}
          active={s.fingerDrawing}
          onClick={() => setInkTool({ fingerDrawing: !s.fingerDrawing })}
        >
          <Hand />
        </RbButton>
        {debug.active && (
          // The iPad prototype's debug menu (docs/ink-i2-test.md), behind the bug button.
          <RbButton label="Pen layer debug" active={debugOpen} onClick={() => setDebugOpen(!debugOpen)}>
            <Bug />
          </RbButton>
        )}
      </Group>
      {debug.active && debugOpen && (
        <Group label="Debug">
          <RbButton label={debug.renderer === 'pencilkit' ? 'PencilKit (not saved)' : 'Notivelo renderer'} active={debug.renderer === 'pencilkit'} className="rb-text" onClick={() => debug.setRenderer?.(debug.renderer === 'pencilkit' ? 'notivelo' : 'pencilkit')}>
            <span className="rb-btn-label">{debug.renderer === 'pencilkit' ? 'PencilKit' : 'Notivelo'}</span>
          </RbButton>
          <RbButton label="Web ink overlay" active={debug.webOverlay} className="rb-text" onClick={() => useNativeInkDebug.setState({ webOverlay: !debug.webOverlay })}>
            <span className="rb-btn-label">Overlay</span>
          </RbButton>
          <RbButton label="Fill with test strokes" className="rb-text" onClick={() => debug.fill?.()}>
            <span className="rb-btn-label">Fill test page</span>
          </RbButton>
        </Group>
      )}
    </>
  );
}
