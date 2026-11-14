//! The native app menu, macOS only: Windows and Linux have no window menu bar.
//! Everything in it is also reachable there through the command palette and
//! keyboard shortcuts (src/platform/tauri/menuless.ts). App items carry the id
//! of a command in the web app's command registry (src/hooks/useShortcuts.ts)
//! prefixed with "cmd:"; clicking one emits `menu-command` with that id to the
//! main window, where src/platform/tauri.ts runs it. Edit items use the OS's
//! own actions. The tray menu shares `on_event`, so that stays on every platform.

use tauri::{AppHandle, Emitter, Runtime};

pub const QUICK_CAPTURE: &str = "app:quick-capture";
pub const CHANGE_SERVER: &str = "app:change-server";
pub const CHECK_UPDATES: &str = "app:check-updates";
pub const SHOW_MAIN: &str = "app:show";

#[cfg(target_os = "macos")]
pub use app_menu::build;

#[cfg(target_os = "macos")]
mod app_menu {
    use super::{CHANGE_SERVER, QUICK_CAPTURE};
    use tauri::{
        menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu},
        AppHandle, Runtime,
    };

    /// (command id, label, accelerator)
    type Item = (&'static str, &'static str, Option<&'static str>);

    const FILE: &[Item] = &[
        ("pages.new", "New Page", Some("CmdOrCtrl+N")),
        ("tasks.new", "New Task", Some("CmdOrCtrl+Shift+T")),
        ("page.print", "Print…", Some("CmdOrCtrl+P")),
    ];
    const VIEW: &[Item] = &[
        ("app.palette", "Search or Run a Command…", Some("CmdOrCtrl+K")),
        ("app.sidebar", "Toggle Sidebar", Some("CmdOrCtrl+\\")),
        ("app.theme", "Switch Theme", None),
    ];
    const GO: &[Item] = &[
        ("nav.today", "Today", Some("CmdOrCtrl+1")),
        ("nav.upcoming", "Upcoming", Some("CmdOrCtrl+2")),
        ("nav.my", "My Tasks", Some("CmdOrCtrl+3")),
        ("nav.team", "Team", Some("CmdOrCtrl+4")),
        ("nav.all", "All tasks", Some("CmdOrCtrl+5")),
        ("nav.calendar", "Calendar", Some("CmdOrCtrl+6")),
        ("nav.notes", "Notes", Some("CmdOrCtrl+8")),
    ];
    const HELP: &[Item] = &[("app.shortcuts", "Keyboard Shortcuts", Some("CmdOrCtrl+/"))];

    fn items<R: Runtime>(app: &AppHandle<R>, list: &[Item]) -> tauri::Result<Vec<MenuItem<R>>> {
        list.iter()
            .map(|(id, label, accel)| MenuItem::with_id(app, format!("cmd:{id}"), *label, true, *accel))
            .collect()
    }

    fn refs<R: Runtime>(v: &[MenuItem<R>]) -> Vec<&dyn tauri::menu::IsMenuItem<R>> {
        v.iter().map(|i| i as &dyn tauri::menu::IsMenuItem<R>).collect()
    }

    pub fn build<R: Runtime>(app: &AppHandle<R>, app_name: &str) -> tauri::Result<Menu<R>> {
        let sep = || PredefinedMenuItem::separator(app);
        let about = PredefinedMenuItem::about(app, None, Some(AboutMetadata { name: Some(app_name.into()), ..Default::default() }))?;
        let quick = MenuItem::with_id(app, QUICK_CAPTURE, "Quick Capture…", true, Some(crate::quick::SHORTCUT))?;
        let server = MenuItem::with_id(app, CHANGE_SERVER, "Change Server…", true, None::<&str>)?;
        // No "Check for Updates…" in the Mac App Store build (no updater; the store updates the app).
        #[cfg(feature = "updater")]
        let updates = MenuItem::with_id(app, super::CHECK_UPDATES,"Check for Updates…", true, None::<&str>)?;
        let settings = MenuItem::with_id(app, "cmd:nav.settings", "Settings…", true, Some("CmdOrCtrl+,"))?;

        let file_items = items(app, FILE)?;
        let mut file = refs(&file_items);
        let (s1, s2) = (sep()?, sep()?);
        file.push(&s1);
        file.push(&quick);
        let close = PredefinedMenuItem::close_window(app, None)?;
        file.push(&s2);
        file.push(&close);
        let file = Submenu::with_items(app, "File", true, &file)?;

        let edit = Submenu::with_items(
            app,
            "Edit",
            true,
            &[
                &PredefinedMenuItem::undo(app, None)?,
                &PredefinedMenuItem::redo(app, None)?,
                &sep()?,
                &PredefinedMenuItem::cut(app, None)?,
                &PredefinedMenuItem::copy(app, None)?,
                &PredefinedMenuItem::paste(app, None)?,
                &PredefinedMenuItem::select_all(app, None)?,
            ],
        )?;

        let view_items = items(app, VIEW)?;
        let mut view = refs(&view_items);
        let s3 = sep()?;
        let fullscreen = PredefinedMenuItem::fullscreen(app, None)?;
        view.push(&s3);
        view.push(&fullscreen);
        let view = Submenu::with_items(app, "View", true, &view)?;

        let go_items = items(app, GO)?;
        let go = Submenu::with_items(app, "Go", true, &refs(&go_items))?;

        let window = Submenu::with_items(
            app,
            "Window",
            true,
            &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::maximize(app, None)?],
        )?;

        let help_items = items(app, HELP)?;
        let help = Submenu::with_items(app, "Help", true, &refs(&help_items))?;

        // "Change Server…" only in builds that may switch servers (debug / internal; config.rs).
        let (a1, a2, a3, a4) = (sep()?, sep()?, sep()?, sep()?);
        let services = PredefinedMenuItem::services(app, None)?;
        let hide = PredefinedMenuItem::hide(app, None)?;
        let hide_others = PredefinedMenuItem::hide_others(app, None)?;
        let show_all = PredefinedMenuItem::show_all(app, None)?;
        let quit = PredefinedMenuItem::quit(app, None)?;
        let mut app_items: Vec<&dyn tauri::menu::IsMenuItem<R>> = vec![&about];
        #[cfg(feature = "updater")]
        app_items.push(&updates);
        app_items.push(&a1);
        app_items.push(&settings);
        if crate::config::switchable() {
            app_items.push(&server);
        }
        let rest: [&dyn tauri::menu::IsMenuItem<R>; 8] = [&a2, &services, &a3, &hide, &hide_others, &show_all, &a4, &quit];
        app_items.extend(rest);
        let app_menu = Submenu::with_items(app, app_name, true, &app_items)?;
        Menu::with_items(app, &[&app_menu, &file, &edit, &view, &go, &window, &help])
    }
}

/// Handles clicks on the app menu and the tray menu.
pub fn on_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    if let Some(cmd) = id.strip_prefix("cmd:") {
        crate::show_main(app);
        let _ = app.emit_to("main", "menu-command", cmd.to_string());
        return;
    }
    match id {
        QUICK_CAPTURE => crate::quick::toggle(app),
        SHOW_MAIN => crate::show_main(app),
        CHANGE_SERVER if crate::config::switchable() => {
            crate::show_main(app);
            let _ = app.emit_to("main", "change-server", ());
        }
        CHECK_UPDATES => {
            crate::show_main(app);
            let _ = app.emit_to("main", "check-updates", ());
        }
        "app:quit" => app.exit(0),
        _ => {}
    }
}
