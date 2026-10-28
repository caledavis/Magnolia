//! Auto-update via GitHub Releases (tauri-plugin-updater, signed bundles).
//!
//! - Shortly after the main window opens, check silently; if a newer
//!   version exists, download it in the background, then show the
//!   renderer's update dialog (release notes + Skip / Later / Install Now).
//! - "Later" keeps the download; it installs when the app quits.
//! - Help → "Check for Updates…" and the Preferences pane run the same flow
//!   with visible feedback (native dialogs vs. inline `update:status`).
//! - The toolbar badge reflects "a newer version is published" on every
//!   build, including ones that can't self-install.
//!
//! Publishing is described in RELEASING.md.

use crate::storage;
use crate::windows::{self, MAIN};
use serde_json::{Value, json};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Clone, Copy, PartialEq)]
pub enum Source {
    Menu,
    Preferences,
    Startup,
}

struct Downloaded {
    update: Update,
    bytes: Vec<u8>,
}

static BADGE: Mutex<Option<Value>> = Mutex::new(None);
static DOWNLOADED: Mutex<Option<Downloaded>> = Mutex::new(None);
static STARTUP_SCHEDULED: AtomicBool = AtomicBool::new(false);
static CHECKING: AtomicBool = AtomicBool::new(false);

fn current_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

pub fn badge_state(app: &AppHandle) -> Value {
    BADGE
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_else(|| json!({ "available": false, "latestVersion": null, "currentVersion": current_version(app) }))
}

fn set_badge(app: &AppHandle, latest: Option<&str>) {
    let available = latest.is_some_and(|v| storage::skipped_version().as_deref() != Some(v));
    let state = json!({ "available": available, "latestVersion": latest, "currentVersion": current_version(app) });
    *BADGE.lock().unwrap() = Some(state.clone());
    windows::emit_to(app, MAIN, "update:badge", state);
}

fn send_status(app: &AppHandle, state: &str, version: Option<&str>, message: Option<&str>) {
    windows::emit_to(
        app,
        MAIN,
        "update:status",
        json!({ "state": state, "version": version, "message": message }),
    );
}

fn info_box(app: &AppHandle, title: &str, detail: &str, kind: MessageDialogKind) {
    let app = app.clone();
    let (title, detail) = (title.to_string(), detail.to_string());
    std::thread::spawn(move || {
        app.dialog()
            .message(detail)
            .title(title)
            .kind(kind)
            .blocking_show();
    });
}

pub fn schedule_startup_check(app: &AppHandle) {
    if STARTUP_SCHEDULED.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_secs(5)))
            .await
            .ok();
        run_check(&app, Source::Startup).await;
    });
}

pub fn check_manually(app: &AppHandle, source: Source) {
    if cfg!(debug_assertions) {
        match source {
            Source::Preferences => send_status(app, "dev-disabled", None, None),
            _ => info_box(
                app,
                "Update checks are disabled in development",
                "Build a release bundle (`npm run tauri build`) to test the update flow.",
                MessageDialogKind::Info,
            ),
        }
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move { run_check(&app, source).await });
}

async fn run_check(app: &AppHandle, source: Source) {
    // Dev-only override for exercising the badge UI.
    if cfg!(debug_assertions) {
        if let Ok(forced) = std::env::var("MAGNOLIA_FORCE_UPDATE_BADGE") {
            let v = if forced.starts_with(|c: char| c.is_ascii_digit()) {
                forced
            } else {
                "99.0.0".into()
            };
            set_badge(app, Some(&v));
        }
        return;
    }
    if CHECKING.swap(true, Ordering::SeqCst) {
        return;
    }
    if source == Source::Preferences {
        send_status(app, "checking", None, None);
    }
    let result = async {
        let updater = app.updater().map_err(|e| e.to_string())?;
        updater.check().await.map_err(|e| e.to_string())
    }
    .await;
    CHECKING.store(false, Ordering::SeqCst);

    let update = match result {
        Ok(u) => u,
        Err(e) => {
            log::error!("[auto-update] check failed: {e}");
            match source {
                Source::Preferences => send_status(app, "error", None, Some(&e)),
                Source::Menu => info_box(
                    app,
                    "Could not check for updates",
                    &e,
                    MessageDialogKind::Error,
                ),
                Source::Startup => {}
            }
            return;
        }
    };
    let Some(update) = update else {
        set_badge(app, None);
        let v = current_version(app);
        match source {
            Source::Preferences => send_status(app, "up-to-date", Some(&v), None),
            Source::Menu => info_box(
                app,
                "Magnolia is up to date",
                &format!("Version {v} is the latest available."),
                MessageDialogKind::Info,
            ),
            Source::Startup => {}
        }
        return;
    };
    set_badge(app, Some(&update.version));
    if source == Source::Preferences {
        send_status(app, "available", Some(&update.version), None);
    }
    // Respect "Skip This Version" for automatic checks only.
    if source == Source::Startup
        && storage::skipped_version().as_deref() == Some(update.version.as_str())
    {
        return;
    }
    let already = DOWNLOADED
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|d| d.update.version == update.version);
    if !already {
        match update.download(|_, _| {}, || {}).await {
            Ok(bytes) => {
                *DOWNLOADED.lock().unwrap() = Some(Downloaded {
                    update: update.clone(),
                    bytes,
                })
            }
            Err(e) => {
                log::error!("[auto-update] download failed: {e}");
                if source == Source::Menu {
                    info_box(
                        app,
                        "Could not download the update",
                        &e.to_string(),
                        MessageDialogKind::Error,
                    );
                }
                return;
            }
        }
    }
    announce(app, &update);
}

fn announce(app: &AppHandle, update: &Update) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app
        .notification()
        .builder()
        .title("Magnolia update ready")
        .body(format!("Version {} is ready to install.", update.version))
        .show();
    let payload = json!({
        "version": update.version,
        "currentVersion": update.current_version,
        "releaseDate": update.date.map(|d| d.to_string()),
        "releaseNotes": update.body.clone().unwrap_or_default(),
    });
    if tauri::Manager::get_webview_window(app, MAIN).is_some() {
        windows::emit_to(app, MAIN, "update-available", payload);
    } else {
        // No main window to host the dialog: ask natively.
        let app = app.clone();
        let version = update.version.clone();
        std::thread::spawn(move || {
            let restart = app
                .dialog()
                .message(
                    "Restart now to apply the update, or quit later — it installs automatically.",
                )
                .title(format!("Magnolia {version} is ready to install"))
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "Restart now".into(),
                    "Later".into(),
                ))
                .blocking_show();
            if restart {
                install_now(&app);
            }
        });
    }
}

/// Install the downloaded update and relaunch. The quit is intentional, so
/// the welcome screen must not reappear.
pub fn install_now(app: &AppHandle) {
    let Some(d) = DOWNLOADED.lock().unwrap().take() else {
        return;
    };
    if let Err(e) = d.update.install(&d.bytes) {
        log::error!("[auto-update] install failed: {e}");
        info_box(
            app,
            "Could not install the update",
            &e.to_string(),
            MessageDialogKind::Error,
        );
        return;
    }
    app.restart();
}

/// "Later" → the staged update installs as the app quits.
pub fn install_pending_on_quit(_app: &AppHandle) {
    if let Some(d) = DOWNLOADED.lock().unwrap().take()
        && let Err(e) = d.update.install(&d.bytes)
    {
        log::error!("[auto-update] install on quit failed: {e}");
    }
}

pub fn skip(app: &AppHandle, version: &str) {
    storage::set_skipped_version(version);
    let latest = badge_state(app)
        .get("latestVersion")
        .and_then(Value::as_str)
        .map(str::to_string);
    if latest.as_deref() == Some(version) {
        set_badge(app, Some(version));
    }
}

#[tauri::command]
pub async fn get_update_badge(app: AppHandle) -> Result<Value, String> {
    Ok(badge_state(&app))
}

#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    windows::quit_for_update(&app);
    Ok(())
}

#[tauri::command]
pub async fn update_skip(app: AppHandle, version: String) -> Result<(), String> {
    skip(&app, &version);
    Ok(())
}

#[tauri::command]
pub async fn update_remind_later() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> Result<(), String> {
    check_manually(&app, Source::Preferences);
    Ok(())
}
