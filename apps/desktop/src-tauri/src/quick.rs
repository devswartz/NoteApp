//! Quick capture: a global hotkey (⌥⌘N / Ctrl+Alt+N) toggles a small
//! always-on-top window that adds a task or a note without switching to the
//! main window. The window loads the same web app; src/platform/tauri.ts sees
//! the "quick" label and renders the quick-capture form instead of the app.

use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

pub const LABEL: &str = "quick";
pub const SHORTCUT: &str = "Alt+CmdOrCtrl+N";
const WIDTH: f64 = 560.0;
const HEIGHT: f64 = 132.0;

pub fn register<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let plugin = tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                toggle(app);
            }
        })
        .build();
    app.plugin(plugin)?;
    // Another app may own the shortcut; the menu item still works then.
    if let Err(e) = app.global_shortcut().register(SHORTCUT) {
        eprintln!("quick capture: couldn't register {SHORTCUT}: {e}");
    }
    Ok(())
}

pub fn toggle<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window(LABEL) {
        if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) {
            let _ = w.hide();
        } else {
            let _ = w.center();
            let _ = w.show();
            let _ = w.set_focus();
        }
        return;
    }
    // The first press builds the window; off the main thread (see `build_window`).
    crate::build_window(app, "quick capture", create);
}

fn create<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let cfg = crate::config::load(app);
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
        .title("Quick Capture")
        .inner_size(WIDTH, HEIGHT)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .decorations(false)
        .center()
        .focused(true)
        .initialization_script(crate::config::init_script(&cfg))
        .build()?;
    Ok(())
}
