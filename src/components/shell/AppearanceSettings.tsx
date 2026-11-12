import { Check, Contrast, Monitor, Moon, Sun } from 'lucide-react';
import { ACCENTS, setAccent, setThemePref, useAccent, useTheme, type ThemePref } from '../../store/ui.ts';
import { Segmented, useIsMobile } from '../ui.tsx';
import { sidebar, useSidebar } from './sidebarState.ts';

const OPTIONS: { value: ThemePref; label: string; icon: React.ReactNode }[] = [
  { value: 'light', label: 'Light', icon: <Sun size={15} /> },
  { value: 'dark', label: 'Dark', icon: <Moon size={15} /> },
  { value: 'hybrid', label: 'Hybrid', icon: <Contrast size={15} /> },
  { value: 'system', label: 'System', icon: <Monitor size={15} /> },
];

/** Appearance on this device: theme, accent colour and the Notes panel layout. */
export function AppearanceSettings() {
  const pref = useTheme((s) => s.pref);
  const pagesPanel = useSidebar((s) => s.pagesPanel);
  const isMobile = useIsMobile();
  return (
    <>
      <div className="setting-row">
        <div className="grow">
          <div className="setting-title">Theme</div>
          <div className="muted small">“Hybrid” keeps the app dark and the page light. “System” follows your device’s light or dark setting.</div>
        </div>
        <Segmented label="Theme" value={pref} options={OPTIONS} onChange={setThemePref} />
      </div>
      <div className="setting-row">
        <div className="grow">
          <div className="setting-title" id="accent-title">
            Accent colour
          </div>
          <div className="muted small">Buttons, links, selection and the highlighted item in lists.</div>
        </div>
        <AccentPicker />
      </div>
      <ThemePreviews />
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

/** A row of swatches: native radio buttons (arrow keys move between them), each named by its colour. */
function AccentPicker() {
  const accent = useAccent((s) => s.accent);
  return (
    <div className="accent-picker" role="radiogroup" aria-labelledby="accent-title">
      {ACCENTS.map((a) => (
        <label key={a.id} className="accent-swatch" title={a.label} style={{ ['--swatch' as string]: a.swatch }}>
          <input type="radio" name="accent" value={a.id} checked={accent === a.id} aria-label={a.label} onChange={() => setAccent(a.id)} />
          <span className="accent-dot" aria-hidden="true">
            <Check size={14} strokeWidth={3} />
          </span>
        </label>
      ))}
    </div>
  );
}

/** Light, Dark and Hybrid in miniature with the current accent; picking one switches to it. */
function ThemePreviews() {
  const pref = useTheme((s) => s.pref);
  const tiles: { id: ThemePref; label: string; chrome: string; page: string }[] = [
    { id: 'light', label: 'Light', chrome: 'scheme-light', page: 'scheme-light' },
    { id: 'dark', label: 'Dark', chrome: 'scheme-dark', page: 'scheme-dark' },
    { id: 'hybrid', label: 'Hybrid', chrome: 'scheme-dark', page: 'scheme-light' },
  ];
  return (
    <div className="theme-previews" aria-label="Theme previews" role="group">
      {tiles.map((t) => (
        <button key={t.id} type="button" className={`theme-preview ${pref === t.id ? 'is-active' : ''}`} aria-pressed={pref === t.id} onClick={() => setThemePref(t.id)}>
          <span className={`tp-window ${t.chrome}`} aria-hidden="true">
            <span className="tp-ribbon">
              <span className="tp-pill" />
              <span className="tp-pill short" />
            </span>
            <span className="tp-body">
              <span className="tp-side">
                <span className="tp-row is-active" />
                <span className="tp-row" />
                <span className="tp-row" />
              </span>
              <span className={`tp-page ${t.page}`}>
                <span className="tp-title" />
                <span className="tp-line" />
                <span className="tp-line short" />
                <span className="tp-link" />
                <span className="tp-btn" />
              </span>
            </span>
          </span>
          <span className="tp-label">{t.label}</span>
        </button>
      ))}
    </div>
  );
}
