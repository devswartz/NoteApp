// Debug readout for the iPad prototype (docs/ink-i2-test.md): which part of the ink path is
// working: the flag, the native pen layer (found, attached, or why not), the mode and the Pencil
// switch. Only in the iOS app with the `ink` flag on; a tap hides it until the page is reopened.
import { useState } from 'react';
import { useInkAvailable, useInkTool } from './inkTool.ts';
import { useNativeInkDebug } from './nativeInk.ts';

const isIosApp = () => (globalThis as { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.() === 'ios';

export function InkStatus() {
  const [hidden, setHidden] = useState(false);
  const status = useNativeInkDebug((d) => d.status);
  const gesture = useNativeInkDebug((d) => d.gesture);
  const available = useInkAvailable((a) => a.available);
  const drawMode = useInkTool((s) => s.drawMode);
  const tool = useInkTool((s) => s.tool);
  const pencilSwitches = useInkTool((s) => s.pencilSwitches);
  if (hidden || !isIosApp()) return null;
  const text = [
    'ink flag on',
    available ? status : 'ink not offered on this page (read-only, or the phone layout)',
    drawMode ? `Draw mode (${tool})` : 'Type mode',
    `Pencil switch ${pencilSwitches ? 'on' : 'off'}`,
    `last gesture: ${gesture}`,
  ].join(' · ');
  return (
    <button type="button" className="ink-status" onClick={() => setHidden(true)} title="Ink status (tap to hide)" data-ink-exclude>
      {text}
    </button>
  );
}
