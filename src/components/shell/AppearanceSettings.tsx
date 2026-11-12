import { Monitor, Moon, Sun } from 'lucide-react';
import { setThemePref, useTheme, type ThemePref } from '../../store/ui.ts';
import { Segmented, useIsMobile } from '../ui.tsx';
import { sidebar, useSidebar } from './sidebarState.ts';

const OPTIONS: { value: ThemePref; label: string; icon: React.ReactNode }[] = [
  { value: 'light', label: 'Light', icon: <Sun size={15} /> },
  { value: 'dark', label: 'Dark', icon: <Moon size={15} /> },
  { value: 'system', label: 'System', icon: <Monitor size={15} /> },
];

/** Appearance on this device: theme (light, dark or system) and the Notes panel layout. */
export function AppearanceSettings() {
  const pref = useTheme((s) => s.pref);
  const pagesPanel = useSidebar((s) => s.pagesPanel);
  const isMobile = useIsMobile();
  return (
    <>
      <div className="setting-row">
        <div className="grow">
          <div className="setting-title">Theme</div>
          <div className="muted small">“System” follows your device’s light or dark setting.</div>
        </div>
        <Segmented label="Theme" value={pref} options={OPTIONS} onChange={setThemePref} />
      </div>
      {/* Phones always list pages under their section. */}
      {!isMobile && (
        <div className="setting-row">
          <div className="grow">
            <div className="setting-title">Show pages in a separate panel</div>
            <div className="muted small">Lists a section’s pages in their own panel next to the sections, when the window is wide enough. Off: pages appear under each section.</div>
          </div>
          <label className="switch">
            <input type="checkbox" role="switch" checked={pagesPanel} aria-label="Show pages in a separate panel" onChange={(e) => sidebar.setPagesPanel(e.target.checked)} />
            <span className="switch-track" aria-hidden="true" />
          </label>
        </div>
      )}
    </>
  );
}
