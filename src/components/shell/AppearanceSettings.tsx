import { Monitor, Moon, Sun } from 'lucide-react';
import { setThemePref, useTheme, type ThemePref } from '../../store/ui.ts';
import { Segmented } from '../ui.tsx';

const OPTIONS: { value: ThemePref; label: string; icon: React.ReactNode }[] = [
  { value: 'light', label: 'Light', icon: <Sun size={15} /> },
  { value: 'dark', label: 'Dark', icon: <Moon size={15} /> },
  { value: 'system', label: 'System', icon: <Monitor size={15} /> },
];

/** Theme picker: light, dark, or follow the operating system. */
export function AppearanceSettings() {
  const pref = useTheme((s) => s.pref);
  return (
    <div className="setting-row">
      <div className="grow">
        <div className="setting-title">Theme</div>
        <div className="muted small">“System” follows your device’s light or dark setting.</div>
      </div>
      <Segmented label="Theme" value={pref} options={OPTIONS} onChange={setThemePref} />
    </div>
  );
}
