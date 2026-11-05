//! The native window theme and title bar colour (Windows and Linux; macOS follows
//! the system appearance and is left alone).
//!
//! The theme alone isn't enough on Windows: with "Show accent colour on title
//! bars" turned on, the title bar is the bright accent colour whatever the theme.
//! So on Windows 11 the caption, border and text colours are set explicitly to
//! the app's own background (DwmSetWindowAttribute; older Windows ignores it).
//!
//! The web app owns the setting (light / dark / system, src/store/ui.ts) and
//! reports it, with its resolved background colour, through `set_window_theme`.
//! The last values are kept in `<app config dir>/window-theme.json` so the title
//! bar is right from the first frame next launch. Default: dark.

use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager, Runtime, Theme, WebviewWindow};

type Rgb = [u8; 3];

/// The app's dark background (`--bg` in src/styles), used until the web app has reported one.
const DARK_BG: Rgb = [0x18, 0x18, 0x1b];

#[derive(Serialize, Deserialize, Clone)]
struct Saved {
    /// "light", "dark" or "system".
    pref: String,
    background: Rgb,
}

impl Default for Saved {
    fn default() -> Self {
        Saved { pref: "dark".into(), background: DARK_BG }
    }
}

fn file<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("window-theme.json"))
}

fn load<R: Runtime>(app: &AppHandle<R>) -> Saved {
    file(app).and_then(|p| fs::read_to_string(p).ok()).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

/// "light" and "system" (follow the OS, `None`) are the only values with a
/// special meaning; anything else is dark.
fn theme_of(pref: &str) -> Option<Theme> {
    match pref {
        "light" => Some(Theme::Light),
        "system" => None,
        _ => Some(Theme::Dark),
    }
}

/// Readable text on `bg`: near-black on a light background, near-white on a dark one.
#[cfg(any(windows, test))]
fn text_on(bg: Rgb) -> Rgb {
    let luma = 0.299 * f32::from(bg[0]) + 0.587 * f32::from(bg[1]) + 0.114 * f32::from(bg[2]);
    if luma > 140.0 {
        [0x1a, 0x1a, 0x1a]
    } else {
        [0xf4, 0xf4, 0xf5]
    }
}

/// The theme a new window starts with.
pub fn initial<R: Runtime>(app: &AppHandle<R>) -> Option<Theme> {
    if cfg!(target_os = "macos") {
        return None;
    }
    theme_of(&load(app).pref)
}

/// Colours a new window's title bar with the last saved values.
pub fn decorate<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>) {
    paint(window, load(app).background);
}

/// Applies the preference to every window, paints the title bar and remembers both.
pub fn set<R: Runtime>(app: &AppHandle<R>, pref: &str, background: Option<Rgb>) {
    if cfg!(target_os = "macos") {
        return;
    }
    let pref = if matches!(pref, "light" | "system") { pref } else { "dark" };
    let saved = Saved { pref: pref.into(), background: background.unwrap_or_else(|| load(app).background) };
    if let Some(path) = file(app) {
        if let Some(dir) = path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_string(&saved) {
            let _ = fs::write(path, json);
        }
    }
    let theme = theme_of(pref);
    for window in app.webview_windows().values() {
        let _ = window.set_theme(theme);
        paint(window, saved.background);
    }
}

#[cfg(windows)]
fn paint<R: Runtime>(window: &WebviewWindow<R>, background: Rgb) {
    #[link(name = "dwmapi")]
    extern "system" {
        fn DwmSetWindowAttribute(hwnd: isize, attribute: u32, value: *const core::ffi::c_void, size: u32) -> i32;
    }
    // DWMWA_BORDER_COLOR, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR (Windows 11, build 22000+).
    const BORDER: u32 = 34;
    const CAPTION: u32 = 35;
    const TEXT: u32 = 36;
    // The quick-capture window has no title bar; skip it.
    if window.label() != crate::MAIN {
        return;
    }
    let Ok(hwnd) = window.hwnd() else { return };
    let colorref = |c: Rgb| u32::from(c[0]) | (u32::from(c[1]) << 8) | (u32::from(c[2]) << 16);
    for (attribute, color) in [(CAPTION, background), (BORDER, background), (TEXT, text_on(background))] {
        let value = colorref(color);
        // SAFETY: `hwnd` is this window's live handle and `value` is a 4-byte COLORREF that outlives the call.
        // A failure (Windows 10) is harmless: the title bar keeps the system colours.
        unsafe {
            DwmSetWindowAttribute(hwnd.0 as isize, attribute, (&value as *const u32).cast(), 4);
        }
    }
}

#[cfg(not(windows))]
fn paint<R: Runtime>(_window: &WebviewWindow<R>, _background: Rgb) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_preferences_to_native_themes() {
        assert_eq!(theme_of("light"), Some(Theme::Light));
        assert_eq!(theme_of("system"), None);
        assert_eq!(theme_of("dark"), Some(Theme::Dark));
        assert_eq!(theme_of("anything else"), Some(Theme::Dark));
    }

    #[test]
    fn picks_readable_text() {
        assert_eq!(text_on(DARK_BG), [0xf4, 0xf4, 0xf5]);
        assert_eq!(text_on([0xff, 0xff, 0xff]), [0x1a, 0x1a, 0x1a]);
    }

    #[test]
    fn defaults_to_dark() {
        let d = Saved::default();
        assert_eq!((d.pref.as_str(), d.background), ("dark", DARK_BG));
    }
}
