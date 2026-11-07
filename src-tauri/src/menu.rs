//! The application menu. Most items forward a `menu-action` string to the
//! main window's renderer, which owns the behaviour; the menu is rebuilt when
//! windows open/close (the View menu lists them) and when panel or ribbon
//! visibility changes (checkbox state).

use crate::i18n::t;
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
                Some(t("menu.about").as_str()),
                Some(about_metadata(app)),
            )?)
            .item(&item(app, "check-updates", &t("menu.checkUpdates"), None)?)
            .item(&item(app, "acknowledgements", &t("menu.acknowledgements"), None)?)
            .item(&sep()?)
            .item(&item(app, "preferences", &t("menu.preferences"), Some("Cmd+,"))?)
            .item(&sep()?)
            .item(&PredefinedMenuItem::services(app, Some(&t("menu.services")))?)
            .item(&sep()?)
            .item(&PredefinedMenuItem::hide(app, Some(&t("menu.hide")))?)
            .item(&PredefinedMenuItem::hide_others(app, Some(&t("menu.hideOthers")))?)
            .item(&PredefinedMenuItem::show_all(app, Some(&t("menu.showAll")))?)
            .item(&sep()?)
            .item(&item(app, "quit", &t("menu.quit"), Some("Cmd+Q"))?)
            .build()?;
        menu = menu.item(&app_menu);
    }

    let mut file = SubmenuBuilder::new(app, t("menu.file"))
        .item(&action(app, "new-project", &t("menu.newProject"), None)?)
        .item(&item(
            app,
            "open-project",
            &t("menu.openProject"),
            Some("CmdOrCtrl+O"),
        )?)
        .item(&action(
            app,
            "save-project",
            &t("menu.saveProject"),
            Some("CmdOrCtrl+S"),
        )?)
        .item(&action(
            app,
            "save-project-as",
            &t("menu.saveProjectAs"),
            Some("CmdOrCtrl+Shift+S"),
        )?)
        .item(&sep()?)
        .item(&action(
            app,
            "open-project-details",
            &t("menu.projectDetails"),
            None,
        )?)
        .item(&sep()?)
        .item(&action(
            app,
            "import-document",
            &t("menu.importDocument"),
            Some("CmdOrCtrl+I"),
        )?)
        .item(&sep()?);
    file = if mac {
        // Cmd+W closes a pop-out window, but in the main window closes the
        // active document tab instead.
        file.item(&item(app, "close-tab", &t("menu.closeTab"), Some("Cmd+W"))?)
    } else {
        file.item(&item(app, "quit", &t("menu.quit"), Some("Ctrl+Q"))?)
    };
    menu = menu.item(&file.build()?);

    let edit = SubmenuBuilder::new(app, t("menu.edit"))
        .item(&PredefinedMenuItem::undo(app, Some(&t("menu.undo")))?)
        .item(&PredefinedMenuItem::redo(app, Some(&t("menu.redo")))?)
        .item(&sep()?)
        .item(&PredefinedMenuItem::cut(app, Some(&t("menu.cut")))?)
        .item(&PredefinedMenuItem::copy(app, Some(&t("menu.copy")))?)
        .item(&PredefinedMenuItem::paste(app, Some(&t("menu.paste")))?)
        .item(&PredefinedMenuItem::select_all(app, Some(&t("menu.selectAll")))?)
        .build()?;
    menu = menu.item(&edit);

    let codes = SubmenuBuilder::new(app, t("menu.codes"))
        .item(&action(app, "new-code", &t("menu.newCode"), Some("CmdOrCtrl+N"))?)
        .item(&sep()?)
        .item(&action(app, "show-codebook", &t("menu.codebook"), None)?)
        .item(&sep()?)
        .item(&action(
            app,
            "import-codebook",
            &t("menu.importCodebook"),
            None,
        )?)
        .item(&action(
            app,
            "export-codebook",
            &t("menu.exportCodebook"),
            None,
        )?)
        .build()?;
    menu = menu.item(&codes);

    let documents = SubmenuBuilder::new(app, t("menu.documents"))
        .item(&action(
            app,
            "import-document-docs",
            &t("menu.importDocument"),
            None,
        )?)
        .item(&sep()?)
        .item(&action(app, "new-doc-folder", &t("menu.newFolder"), None)?)
        .item(&sep()?)
        .item(&action(
            app,
            "manage-doc-tags",
            &t("menu.manageDocumentTags"),
            None,
        )?)
        .build()?;
    menu = menu.item(&documents);

    // The standard tab-switching shortcuts (as in Safari and every
    // browser). The renderer also takes Cmd+Shift+] / [ on macOS and
    // Ctrl+PageDown / PageUp elsewhere; a menu item holds only one.
    let mut view = SubmenuBuilder::new(app, t("menu.view"))
        .item(&item(app, "previous-tab", &t("menu.previousTab"), Some("Ctrl+Shift+Tab"))?)
        .item(&item(app, "next-tab", &t("menu.nextTab"), Some("Ctrl+Tab"))?)
        .item(&sep()?);
    // Shows or collapses the ribbon's buttons (the renderer reports
    // "ribbon": true/false with the panel visibility). Greyed out when the
    // toolbar style isn't Ribbon, which leaves "ribbon" out.
    let ribbon = visibility.get("ribbon").and_then(Value::as_bool);
    view = view
        .item(
            &CheckMenuItemBuilder::with_id(format!("{ACTION}toggle-ribbon"), t("menu.showRibbon"))
                .checked(ribbon.unwrap_or(false))
                .enabled(ribbon.is_some())
                .build(app)?,
        )
        .item(&sep()?);
    for (key, label) in [
        ("documents", "menu.panelDocuments"),
        ("codes", "menu.panelCodes"),
        ("queries", "menu.panelQueries"),
        ("memos", "menu.panelMemos"),
        ("quotes", "menu.panelQuotes"),
        ("analyses", "menu.panelAnalyses"),
    ] {
        let check = CheckMenuItemBuilder::with_id(format!("{ACTION}toggle-panel-{key}"), t(label))
            .checked(shown(key))
            .build(app)?;
        view = view.item(&check);
    }
    view = view
        .item(&sep()?)
        .item(&item(app, "reload", &t("menu.reload"), Some("CmdOrCtrl+R"))?);
    // Release builds have no devtools (tauri's `devtools` feature is off).
    #[cfg(debug_assertions)]
    {
        view = view.item(&item(
            app,
            "devtools",
            &t("menu.devtools"),
            Some(if mac { "Alt+Cmd+I" } else { "Ctrl+Shift+I" }),
        )?);
    }
    view = view
        .item(&sep()?)
        .item(&PredefinedMenuItem::fullscreen(app, None)?);
    let open_windows = window_list(app);
    if app.get_webview_window(MAIN).is_some() && !open_windows.is_empty() {
        view = view.item(&sep()?);
        for (label, title) in open_windows {
            let title = if title.is_empty() {
                "Magnolia".to_string()
            } else {
                title
            };
            view = view.item(&item(app, &format!("{FOCUS}{label}"), &title, None)?);
        }
    }
    menu = menu.item(&view.build()?);

    let mut help = SubmenuBuilder::new(app, t("menu.help"))
        .item(&item(app, "github", &t("menu.github"), None)?)
        .item(&item(app, "sponsor", &t("menu.sponsor"), None)?);
    if !mac {
        help = help
            .item(&sep()?)
            .item(&item(app, "check-updates", &t("menu.checkUpdates"), None)?)
            .item(&item(app, "acknowledgements", &t("menu.acknowledgements"), None)?)
            .item(&PredefinedMenuItem::about(
                app,
                Some(t("menu.about").as_str()),
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
            format!("{}\n\nhttps://github.com/caledavis/Magnolia\n\n{}", t("menu.aboutCredits"), t("menu.aboutBuiltWith")),
        ),
        license: Some("EUPL-1.2".into()),
        website: Some("https://github.com/caledavis/Magnolia".into()),
        ..Default::default()
    }
}

/// The View menu's window list: (label, title) with the main window first.
/// The title leaves out " — Magnolia" and the " — Edited" marker, so
/// editing or saving the project doesn't change the menu.
fn window_list(app: &AppHandle) -> Vec<(String, String)> {
    let mut list: Vec<(String, String)> = app
        .webview_windows()
        .into_iter()
        .filter(|(l, _)| l != WELCOME)
        .map(|(l, w)| {
            let title = w.title().unwrap_or_default();
            (l, title.replace(" — Magnolia", "").replace(" — Edited", ""))
        })
        .collect();
    list.sort_by_key(|(l, _)| (l != MAIN, l.clone()));
    list
}

/// What the menu shows that can change: panel visibility and the window
/// list. Installing a new menu makes the macOS menu bar flicker, so a
/// rebuild that wouldn't change it is skipped.
fn contents_key(app: &AppHandle) -> String {
    let visibility = app.state::<AppState>().ui.lock().unwrap().panel_visibility.clone();
    format!("{visibility:?}|{:?}|{}|{}", window_list(app), app.get_webview_window(MAIN).is_some(), crate::i18n::language())
}

static INSTALLED: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// Rebuild and install the app menu (a window opened or closed). On
/// Windows and Linux it is installed on the main window alone.
pub fn rebuild(app: &AppHandle) {
    install(app, true);
}

/// Rebuild the menu only if what it shows has changed (a window was
/// renamed, or panel visibility was reported).
pub fn rebuild_if_changed(app: &AppHandle) {
    install(app, false);
}

fn install(app: &AppHandle, force: bool) {
    let handle = app.clone();
    // Menus must be built on the main thread.
    let _ = app.run_on_main_thread(move || {
        let key = contents_key(&handle);
        let mut installed = INSTALLED.lock().unwrap();
        if !force && installed.as_deref() == Some(key.as_str()) {
            return;
        }
        match build(&handle) {
            Ok(m) => {
                // macOS has one menu bar for the app. Windows and Linux draw
                // the app menu in every window, so there it goes on the main
                // window only: the welcome screen and the pop-outs (Codebook,
                // Logbook, memos…) don't need one. Clicks reach the app-wide
                // on_menu_event either way.
                #[cfg(target_os = "macos")]
                let _ = handle.set_menu(m);
                #[cfg(not(target_os = "macos"))]
                if let Some(w) = handle.get_webview_window(MAIN) {
                    let _ = w.set_menu(m);
                }
                *installed = Some(key);
            }
            Err(e) => log::error!("menu build failed: {e}"),
        }
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
