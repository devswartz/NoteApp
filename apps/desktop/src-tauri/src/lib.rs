//! Notivelo desktop shell. The window loads the bundled web app (dist/), so it
//! starts instantly and opens offline; only the API is remote (see config.rs).
//! Everything app-specific happens in the web app; this side adds what a
//! browser can't: keychain, app menu (macOS), tray, global hotkey, deep links,
//! single instance, window state and auto-update.

mod config;
mod menu;
mod quick;
mod secure;
#[cfg(target_os = "macos")]
mod spelling;
mod theme;
mod tray;

use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_window_state::StateFlags;

const MAIN: &str = "main";

pub(crate) fn show_main<R: Runtime>(app: &AppHandle<R>) {
    match app.get_webview_window(MAIN) {
        Some(w) => {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
        // Gone (closed on Windows/Linux; the app lives on in the tray): build it again.
        None => build_window(app, "main window", create_main),
    }
}

/// Builds a window on a separate thread. Callers run on the main thread (tray,
/// menu, single-instance and global-shortcut handlers, sync commands), and on
/// Windows `WebviewWindowBuilder::build` deadlocks there: it waits for WebView2,
/// which needs the event loop the caller is blocking. From another thread the
/// build is handed to the event loop and the caller returns at once.
pub(crate) fn build_window<R: Runtime>(
    app: &AppHandle<R>,
    what: &'static str,
    build: fn(&AppHandle<R>) -> tauri::Result<()>,
) {
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(e) = build(&app) {
            eprintln!("{what}: {e}");
        }
    });
}

fn create_main<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let cfg = config::load(app);
    // Only macOS has a menu (one app-wide menu bar, set in setup). Windows and
    // Linux have none: the command palette and shortcuts cover every action.
    let mut builder = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()));
    if let Some(t) = theme::initial(app) {
        builder = builder.theme(Some(t));
    }
    let window = builder
        .title(app.package_info().name.clone())
        .inner_size(1200.0, 800.0)
        .min_inner_size(420.0, 480.0)
        // Let the web app handle drag-and-drop (sidebar reordering, file drops) itself.
        .disable_drag_drop_handler()
        .initialization_script(config::init_script(&cfg))
        .build()?;
    theme::decorate(app, &window);
    Ok(())
}

// ───────────── Commands called from src/platform/tauri.ts ─────────────

#[tauri::command]
fn server_config(app: AppHandle) -> config::ServerConfig {
    config::load(&app)
}

/// Saves the server and restarts, so every window starts with the new URL
/// (it's injected when a window is created, before the web app's scripts).
#[tauri::command]
fn set_server(app: AppHandle, url: String) -> Result<(), String> {
    config::save(&app, &url)?;
    app.restart()
}

fn current_server(app: &AppHandle) -> String {
    config::load(app).url
}

#[tauri::command]
fn secure_get(app: AppHandle, key: String) -> Result<Option<String>, String> {
    secure::get(&current_server(&app), &key)
}

#[tauri::command]
fn secure_set(app: AppHandle, key: String, value: String) -> Result<(), String> {
    secure::set(&current_server(&app), &key, &value)
}

#[tauri::command]
fn secure_remove(app: AppHandle, key: String) -> Result<(), String> {
    secure::remove(&current_server(&app), &key)
}

#[tauri::command]
fn set_today_count(app: AppHandle, count: u32) {
    tray::set_today_count(&app, count);
}

/// The web app's theme preference ("light", "dark" or "system") and its resolved
/// background colour → the native title bar.
#[tauri::command]
fn set_window_theme(app: AppHandle, theme: String, background: Option<[u8; 3]>) {
    theme::set(&app, &theme, background);
}

#[tauri::command]
fn hide_quick_capture(app: AppHandle) {
    if let Some(w) = app.get_webview_window(quick::LABEL) {
        let _ = w.hide();
    }
}

/// Brings the main window forward (used by the quick-capture window, e.g. to sign in).
#[tauri::command]
fn show_main_window(app: AppHandle) {
    show_main(&app);
}

#[tauri::command]
fn updater_enabled(app: AppHandle) -> bool {
    updater_configured(&app)
}

fn updater_configured<R: Runtime>(app: &AppHandle<R>) -> bool {
    // CI adds plugins.updater (endpoint + public key) only when release signing
    // is set up; unsigned builds have no updater.
    app.config().plugins.0.contains_key("updater")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Before any webview exists: WebKit reads its spell-check switches once per process.
    #[cfg(target_os = "macos")]
    spelling::register_defaults();
    tauri::Builder::default()
        // Must be first: a second launch (or a deep link on Windows) focuses this instance instead.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| show_main(app)))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_denylist(&[quick::LABEL])
                // Not VISIBLE: on macOS closing the main window only hides it, so a
                // saved "hidden" would relaunch the app with no visible window.
                .with_state_flags(StateFlags::all() - StateFlags::VISIBLE)
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            server_config,
            set_server,
            secure_get,
            secure_set,
            secure_remove,
            set_today_count,
            set_window_theme,
            hide_quick_capture,
            show_main_window,
            updater_enabled,
        ])
        .on_window_event(|window, event| {
            // macOS: closing the main window hides it (the app keeps running in the
            // dock and menu bar, like Notes or Mail), so reopening is instant.
            #[cfg(target_os = "macos")]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == MAIN {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            let _ = (window, event);
        })
        .setup(|app| {
            let handle = app.handle().clone();
            // Locked builds: drop a server choice saved by an older version (before any window reads it).
            config::migrate(&handle);
            let name = app.package_info().name.clone();
            if updater_configured(&handle) {
                handle.plugin(tauri_plugin_updater::Builder::new().build())?;
            }
            #[cfg(any(windows, target_os = "linux"))]
            {
                // macOS registers the scheme from Info.plist; elsewhere register at runtime (dev runs, portable installs).
                use tauri_plugin_deep_link::DeepLinkExt;
                let _ = handle.deep_link().register_all();
            }
            #[cfg(target_os = "macos")]
            handle.set_menu(menu::build(&handle, &name)?)?;
            handle.on_menu_event(|app, e| menu::on_event(app, e.id().as_ref()));
            tray::create(&handle, &name)?;
            quick::register(&handle)?;
            create_main(&handle)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the app")
        .run(|app, event| {
            // macOS: clicking the dock icon with no window open brings the main window back.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { has_visible_windows: false, .. } = event {
                show_main(app);
            }
            // Closing the last window keeps the app in the tray / menu bar; Quit exits.
            if let tauri::RunEvent::ExitRequested { code: None, api, .. } = &event {
                api.prevent_exit();
            }
            let _ = (app, event);
        });
}
