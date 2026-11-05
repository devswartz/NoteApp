//! Menu-bar (macOS) / notification-area (Windows) icon showing how many tasks
//! are due today, with quick actions. The count comes from the web app via the
//! `set_today_count` command, which also sets the dock badge.

use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Runtime,
};

pub const ID: &str = "main-tray";

pub fn create<R: Runtime>(app: &AppHandle<R>, app_name: &str) -> tauri::Result<TrayIcon<R>> {
    use crate::menu::{QUICK_CAPTURE, SHOW_MAIN};
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, SHOW_MAIN, format!("Open {app_name}"), true, None::<&str>)?,
            &MenuItem::with_id(app, QUICK_CAPTURE, "Quick Capture…", true, Some(crate::quick::SHORTCUT))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "cmd:nav.today", "Today", true, None::<&str>)?,
            &MenuItem::with_id(app, "cmd:nav.upcoming", "Upcoming", true, None::<&str>)?,
            &MenuItem::with_id(app, "cmd:pages.new", "New Page", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "app:quit", format!("Quit {app_name}"), true, None::<&str>)?,
        ],
    )?;
    let icon = Image::from_bytes(include_bytes!("../icons/tray.png"))?;
    TrayIconBuilder::with_id(ID)
        .icon(icon)
        .icon_as_template(true)
        .tooltip(app_name)
        .menu(&menu)
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_menu_event(|app, e| crate::menu::on_event(app, e.id().as_ref()))
        .on_tray_icon_event(|tray, e| {
            // Windows: left click opens the app, right click shows the menu.
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                if !cfg!(target_os = "macos") {
                    crate::show_main(tray.app_handle());
                }
            }
        })
        .build(app)
}

pub fn set_today_count<R: Runtime>(app: &AppHandle<R>, count: u32) {
    let name = app.package_info().name.clone();
    if let Some(tray) = app.tray_by_id(ID) {
        // macOS shows text next to the menu-bar icon; Windows only has the tooltip.
        let _ = tray.set_title(if count > 0 { Some(count.to_string()) } else { None });
        let tip = match count {
            0 => format!("{name}: nothing due today"),
            1 => format!("{name}: 1 task due today"),
            n => format!("{name}: {n} tasks due today"),
        };
        let _ = tray.set_tooltip(Some(tip));
    }
    if let Some(w) = app.get_webview_window("main") {
        // Dock badge on macOS (and Linux). Not supported on Windows; the tray tooltip covers it.
        let _ = w.set_badge_count(if count > 0 { Some(count as i64) } else { None });
    }
}
