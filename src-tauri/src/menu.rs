//! The application menu. Most items forward a `menu-action` string to the
//! main window's renderer, which owns the behaviour; the menu is rebuilt when
//! windows open/close (the View menu lists them) and when panel visibility
//! changes (checkbox state).

use crate::state::AppState;
use crate::windows::{self, MAIN, WELCOME};
use serde_json::Value;
use tauri::menu::{
    CheckMenuItemBuilder, Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder,
};
use tauri::{AppHandle, Manager, Wry};

const ACTION: &str = "action:";
const FOCUS: &str = "focus:";

fn item(
    app: &AppHandle,
    id: &str,
    label: &str,
    accel: Option<&str>,
) -> tauri::Result<tauri::menu::MenuItem<Wry>> {
    let mut b = MenuItemBuilder::with_id(id, label);
    if let Some(a) = accel {
        b = b.accelerator(a);
    }
    b.build(app)
}

fn action(
    app: &AppHandle,
    action: &str,
    label: &str,
    accel: Option<&str>,
) -> tauri::Result<tauri::menu::MenuItem<Wry>> {
    item(app, &format!("{ACTION}{action}"), label, accel)
}

fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let mac = cfg!(target_os = "macos");
    let sep = || PredefinedMenuItem::separator(app);
    let visibility = app
        .state::<AppState>()
        .ui
        .lock()
        .unwrap()
        .panel_visibility
        .clone()
        .unwrap_or(Value::Null);
    let shown = |k: &str| visibility.get(k).and_then(Value::as_bool) != Some(false);

    let mut menu = MenuBuilder::new(app);

    if mac {
        let app_menu = SubmenuBuilder::new(app, "Magnolia")
            .item(&PredefinedMenuItem::about(
                app,
                Some("About Magnolia"),
                Some(about_metadata(app)),
            )?)
            .item(&item(app, "check-updates", "Check for Updates…", None)?)
            .item(&item(app, "acknowledgements", "Acknowledgements", None)?)
            .item(&sep()?)
            .item(&item(app, "preferences", "Preferences...", Some("Cmd+,"))?)
            .item(&sep()?)
            .item(&PredefinedMenuItem::services(app, None)?)
            .item(&sep()?)
            .item(&PredefinedMenuItem::hide(app, None)?)
            .item(&PredefinedMenuItem::hide_others(app, None)?)
            .item(&PredefinedMenuItem::show_all(app, None)?)
            .item(&sep()?)
            .item(&item(app, "quit", "Quit Magnolia", Some("Cmd+Q"))?)
            .build()?;
        menu = menu.item(&app_menu);
    }

    let mut file = SubmenuBuilder::new(app, "File")
        .item(&action(app, "new-project", "New Project", None)?)
        .item(&item(
            app,
            "open-project",
            "Open Project...",
            Some("CmdOrCtrl+O"),
        )?)
        .item(&action(
            app,
            "save-project",
            "Save Project",
            Some("CmdOrCtrl+S"),
        )?)
        .item(&action(
            app,
            "save-project-as",
            "Save Project As...",
            Some("CmdOrCtrl+Shift+S"),
        )?)
        .item(&sep()?)
        .item(&action(
            app,
            "open-project-details",
            "Project Details...",
            None,
        )?)
        .item(&sep()?)
        .item(&action(
            app,
            "import-document",
            "Import Document...",
            Some("CmdOrCtrl+I"),
        )?)
        .item(&sep()?);
    file = if mac {
        // Cmd+W closes a pop-out window, but in the main window closes the
        // active document tab instead.
        file.item(&item(app, "close-tab", "Close Tab", Some("Cmd+W"))?)
    } else {
        file.item(&item(app, "quit", "Quit Magnolia", Some("Ctrl+Q"))?)
    };
    menu = menu.item(&file.build()?);

    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .item(&sep()?)
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .build()?;
    menu = menu.item(&edit);

    let codes = SubmenuBuilder::new(app, "Codes")
        .item(&action(app, "new-code", "New Code", Some("CmdOrCtrl+N"))?)
        .item(&sep()?)
        .item(&action(app, "show-codebook", "Codebook", None)?)
        .item(&sep()?)
        .item(&action(
            app,
            "import-codebook",
            "Import Codebook (.qdc)...",
            None,
        )?)
        .item(&action(
            app,
            "export-codebook",
            "Export Codebook (.qdc)...",
            None,
        )?)
        .build()?;
    menu = menu.item(&codes);

    let documents = SubmenuBuilder::new(app, "Documents")
        .item(&action(
            app,
            "import-document-docs",
            "Import Document...",
            None,
        )?)
        .item(&sep()?)
        .item(&action(app, "new-doc-folder", "New Folder", None)?)
        .item(&sep()?)
        .item(&action(
            app,
            "manage-doc-tags",
            "Manage Document Tags...",
            None,
        )?)
        .build()?;
    menu = menu.item(&documents);

    // The standard tab-switching shortcuts (as in Safari and every
    // browser). The renderer also takes Cmd+Shift+] / [ on macOS and
    // Ctrl+PageDown / PageUp elsewhere; a menu item holds only one.
    let mut view = SubmenuBuilder::new(app, "View")
        .item(&item(app, "previous-tab", "Show Previous Tab", Some("Ctrl+Shift+Tab"))?)
        .item(&item(app, "next-tab", "Show Next Tab", Some("Ctrl+Tab"))?)
        .item(&sep()?);
    for (key, label) in [
        ("documents", "Documents"),
        ("codes", "Codes"),
        ("queries", "Queries"),
        ("memos", "Memos"),
        ("quotes", "Quotes"),
        ("analyses", "Analyses"),
    ] {
        let check = CheckMenuItemBuilder::with_id(format!("{ACTION}toggle-panel-{key}"), label)
            .checked(shown(key))
            .build(app)?;
        view = view.item(&check);
    }
    view = view
        .item(&sep()?)
        .item(&item(app, "reload", "Reload", Some("CmdOrCtrl+R"))?);
    // Release builds have no devtools (tauri's `devtools` feature is off).
    #[cfg(debug_assertions)]
    {
        view = view.item(&item(
            app,
            "devtools",
            "Toggle Developer Tools",
            Some(if mac { "Alt+Cmd+I" } else { "Ctrl+Shift+I" }),
        )?);
    }
    view = view
        .item(&sep()?)
        .item(&PredefinedMenuItem::fullscreen(app, None)?);
    let open_windows: Vec<(String, String)> = app
        .webview_windows()
        .into_iter()
        .filter(|(l, _)| l != WELCOME)
        .map(|(l, w)| (l, w.title().unwrap_or_default().replace(" — Magnolia", "")))
        .collect();
    if app.get_webview_window(MAIN).is_some() && !open_windows.is_empty() {
        view = view.item(&sep()?);
        let mut sorted = open_windows;
        sorted.sort_by_key(|(l, _)| (l != MAIN, l.clone()));
        for (label, title) in sorted {
            let title = if title.is_empty() {
                "Magnolia".to_string()
            } else {
                title
            };
            view = view.item(&item(app, &format!("{FOCUS}{label}"), &title, None)?);
        }
    }
    menu = menu.item(&view.build()?);

    let mut help = SubmenuBuilder::new(app, "Help")
        .item(&item(app, "github", "Magnolia on GitHub", None)?)
        .item(&item(app, "sponsor", "Sponsor Magnolia…", None)?);
    if !mac {
        help = help
            .item(&sep()?)
            .item(&item(app, "check-updates", "Check for Updates…", None)?)
            .item(&item(app, "acknowledgements", "Acknowledgements", None)?)
            .item(&PredefinedMenuItem::about(
                app,
                Some("About Magnolia"),
                Some(about_metadata(app)),
            )?);
    }
    menu = menu.item(&help.build()?);
    menu.build()
}

fn about_metadata(app: &AppHandle) -> tauri::menu::AboutMetadata<'static> {
    tauri::menu::AboutMetadata {
        name: Some("Magnolia".into()),
        version: Some(app.package_info().version.to_string()),
        copyright: Some("© 2026 Cale Davis".into()),
        credits: Some(
            "Free and open-source qualitative data analysis.\n\nhttps://github.com/caledavis/Magnolia\n\nBuilt with Tauri, Rust, React, TipTap, and PDF.js. Icons by Lucide.".into(),
        ),
        license: Some("EUPL-1.2".into()),
        website: Some("https://github.com/caledavis/Magnolia".into()),
        ..Default::default()
    }
}

/// Rebuild and install the app menu (window list / checkbox state changed).
pub fn rebuild(app: &AppHandle) {
    let handle = app.clone();
    // Menus must be built on the main thread.
    let _ = app.run_on_main_thread(move || match build(&handle) {
        Ok(m) => {
            let _ = handle.set_menu(m);
        }
        Err(e) => log::error!("menu build failed: {e}"),
    });
}

fn send_action(app: &AppHandle, action: &str) {
    windows::emit_to(app, MAIN, "menu-action", action);
}

pub fn handle_event(app: &AppHandle, id: &str) {
    use tauri_plugin_opener::OpenerExt;
    if let Some(a) = id.strip_prefix(ACTION) {
        // "Import Document…" appears twice; menu ids must be unique.
        let a = if a == "import-document-docs" {
            "import-document"
        } else {
            a
        };
        send_action(app, a);
        return;
    }
    if let Some(label) = id.strip_prefix(FOCUS) {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.show();
            let _ = w.set_focus();
        }
        return;
    }
    match id {
        "quit" => windows::quit(app),
        "check-updates" => crate::updater::check_manually(app, crate::updater::Source::Menu),
        "acknowledgements" => crate::commands::open_bundled_file(app, "THIRD-PARTY-LICENSES.txt"),
        "preferences" => {
            let target = focused_label(app).unwrap_or_else(|| MAIN.to_string());
            windows::emit_to(app, &target, "menu-action", "open-preferences");
        }
        "open-project" => {
            let app = app.clone();
            std::thread::spawn(move || {
                if let Some(path) = crate::commands::pick_qdpx(&app, None) {
                    windows::open_project_in_main(&app, &path);
                }
            });
        }
        // Tabs only live in the main window.
        "next-tab" | "previous-tab" => match focused_label(app) {
            Some(l) if l != MAIN => {}
            _ => send_action(app, id),
        },
        "close-tab" => match focused_label(app) {
            Some(l) if l != MAIN => {
                if let Some(w) = app.get_webview_window(&l) {
                    let _ = w.close();
                }
            }
            _ => send_action(app, "close-active-tab"),
        },
        "reload" => {
            if let Some(w) = focused_label(app).and_then(|l| app.get_webview_window(&l)) {
                let _ = w.eval("location.reload()");
            }
        }
        "devtools" =>
        {
            #[cfg(debug_assertions)]
            if let Some(w) = focused_label(app).and_then(|l| app.get_webview_window(&l)) {
                if w.is_devtools_open() {
                    w.close_devtools()
                } else {
                    w.open_devtools()
                }
            }
        }
        "github" => {
            let _ = app
                .opener()
                .open_url("https://github.com/caledavis/Magnolia", None::<&str>);
        }
        "sponsor" => {
            let _ = app
                .opener()
                .open_url("https://github.com/sponsors/caledavis", None::<&str>);
        }
        _ => {}
    }
}

fn focused_label(app: &AppHandle) -> Option<String> {
    app.webview_windows()
        .into_iter()
        .find(|(_, w)| w.is_focused().unwrap_or(false))
        .map(|(l, _)| l)
}
