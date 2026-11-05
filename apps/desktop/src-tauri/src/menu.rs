//! The native app menu. App items carry the id of a command in the web app's
//! command registry (src/hooks/useShortcuts.ts) prefixed with "cmd:"; clicking
//! one emits `menu-command` with that id to the main window, where
//! src/platform/tauri.ts runs it. Edit items use the OS's own actions.

use tauri::{
    menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Emitter, Runtime,
};

/// (command id, label, accelerator)
type Item = (&'static str, &'static str, Option<&'static str>);

const FILE: &[Item] = &[
    ("pages.new", "New Page", Some("CmdOrCtrl+N")),
    ("tasks.new", "New Task", Some("CmdOrCtrl+Shift+T")),
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
    ("nav.all", "All Tasks", Some("CmdOrCtrl+5")),
    ("nav.calendar", "Calendar", Some("CmdOrCtrl+6")),
    ("nav.completed", "Completed", Some("CmdOrCtrl+7")),
    ("nav.notes", "Notes", Some("CmdOrCtrl+8")),
];
const HELP: &[Item] = &[("app.shortcuts", "Keyboard Shortcuts", Some("CmdOrCtrl+/"))];

pub const QUICK_CAPTURE: &str = "app:quick-capture";
pub const CHANGE_SERVER: &str = "app:change-server";
pub const CHECK_UPDATES: &str = "app:check-updates";
pub const SHOW_MAIN: &str = "app:show";

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
    let updates = MenuItem::with_id(app, CHECK_UPDATES, "Check for Updates…", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "cmd:nav.settings", "Settings…", true, Some("CmdOrCtrl+,"))?;

    let file_items = items(app, FILE)?;
    let mut file = refs(&file_items);
    let (s1, s2) = (sep()?, sep()?);
    file.push(&s1);
    file.push(&quick);
    #[cfg(not(target_os = "macos"))]
    file.push(&settings);
    #[cfg(not(target_os = "macos"))]
    file.push(&server);
    let close = PredefinedMenuItem::close_window(app, None)?;
    file.push(&s2);
    file.push(&close);
    #[cfg(not(target_os = "macos"))]
    let quit = PredefinedMenuItem::quit(app, None)?;
    #[cfg(not(target_os = "macos"))]
    file.push(&quit);
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
    let mut help = refs(&help_items);
    #[cfg(not(target_os = "macos"))]
    help.push(&updates);
    #[cfg(not(target_os = "macos"))]
    help.push(&about);
    let help = Submenu::with_items(app, "Help", true, &help)?;

    #[cfg(target_os = "macos")]
    {
        let app_menu = Submenu::with_items(
            app,
            app_name,
            true,
            &[
                &about,
                &updates,
                &sep()?,
                &settings,
                &server,
                &sep()?,
                &PredefinedMenuItem::services(app, None)?,
                &sep()?,
                &PredefinedMenuItem::hide(app, None)?,
                &PredefinedMenuItem::hide_others(app, None)?,
                &PredefinedMenuItem::show_all(app, None)?,
                &sep()?,
                &PredefinedMenuItem::quit(app, None)?,
            ],
        )?;
        Menu::with_items(app, &[&app_menu, &file, &edit, &view, &go, &window, &help])
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (&server, &updates, &about, &settings);
        Menu::with_items(app, &[&file, &edit, &view, &go, &window, &help])
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
        CHANGE_SERVER => {
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
