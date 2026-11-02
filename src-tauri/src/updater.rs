//! Auto-update via GitHub Releases (tauri-plugin-updater, signed bundles),
//! presented Sparkle-style in a window of its own (`windows::UPDATE`).
//!
//! - Shortly after the main window opens, check silently. If a newer
//!   version exists (and wasn't skipped), open the update window on the
//!   prompt: release notes + Skip This Version / Remind Me Later /
//!   Install Update. Nothing downloads until the user agrees.
//! - Install Update downloads in the window (progress, Cancel), then shows
//!   "Ready to Install" with Install and Relaunch. Closing the window at
//!   that point keeps the download; it installs when the app quits.
//! - Help → "Check for Updates…" opens the window at once and shows the
//!   check in it: checking, then the prompt, "You're up to date" or the
//!   error. Choosing it while a check is already running attaches the
//!   window to that check.
//! - The Preferences pane reports inline (`update:status`) and gets the
//!   prompt when an update is available.
//! - "Skip This Version" silences automatic checks until a newer version
//!   is published. Closing the window mid-check or mid-download cancels.
//! - The toolbar badge reflects "a newer version is published" on every
//!   build, including ones that can't self-install.
//!
//! The window pulls the current view (`update_window_state`) when it loads
//! and follows `update-window:state` after that.
//!
//! Development builds can't check (no signed release to compare against).
//! `MAGNOLIA_FAKE_UPDATE=1` walks the window through a pretend update
//! instead, starting at launch (`=uptodate` and `=error` show those
//! outcomes); `MAGNOLIA_FORCE_UPDATE_BADGE` still drives just the badge.
//!
//! Publishing is described in RELEASING.md.

use crate::storage;
use crate::windows::{self, MAIN, UPDATE};
use serde_json::{Value, json};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tauri::async_runtime::JoinHandle;
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
/// The update the prompt offers, until Install Update downloads it.
static AVAILABLE: Mutex<Option<Update>> = Mutex::new(None);
/// A downloaded update; installs on Install and Relaunch, or on quit.
static DOWNLOADED: Mutex<Option<Downloaded>> = Mutex::new(None);
/// The running download, so Cancel can stop it.
static DOWNLOAD_TASK: Mutex<Option<JoinHandle<()>>> = Mutex::new(None);
static STARTUP_SCHEDULED: AtomicBool = AtomicBool::new(false);
static CHECKING: AtomicBool = AtomicBool::new(false);
/// What the update window shows (`Value::Null` while it's closed).
static VIEW: Mutex<Value> = Mutex::new(Value::Null);
/// The window is showing the running check, not just waiting for a result.
static FOLLOWING: AtomicBool = AtomicBool::new(false);
/// Bumped when the user cancels; a check that started under an older
/// generation finishes quietly.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// Clears `CHECKING` and `FOLLOWING` however a check ends.
struct CheckGuard;

impl Drop for CheckGuard {
    fn drop(&mut self) {
        CHECKING.store(false, Ordering::SeqCst);
        FOLLOWING.store(false, Ordering::SeqCst);
    }
}

fn current_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

fn fake_mode() -> Option<String> {
    if cfg!(debug_assertions) {
        std::env::var("MAGNOLIA_FAKE_UPDATE").ok()
    } else {
        None
    }
}

async fn pause(ms: u64) {
    tauri::async_runtime::spawn_blocking(move || std::thread::sleep(Duration::from_millis(ms)))
        .await
        .ok();
}

// ── Badge and Preferences status ──

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

// ── The update window ──

/// Open (or raise) the window on `view`.
fn show(app: &AppHandle, view: Value) {
    let prompt = view["state"] == "available";
    *VIEW.lock().unwrap() = view.clone();
    windows::show_update_window(app, prompt);
    windows::emit_to(app, UPDATE, "update-window:state", view);
}

/// Change what an open window shows without raising it (progress ticks).
fn refresh(app: &AppHandle, view: Value) {
    *VIEW.lock().unwrap() = view.clone();
    windows::emit_to(app, UPDATE, "update-window:state", view);
}

fn view_state() -> Option<String> {
    VIEW.lock().unwrap()["state"].as_str().map(str::to_string)
}

fn following() -> bool {
    FOLLOWING.load(Ordering::SeqCst)
}

/// Show a step of the check, if the window is following it.
fn report(app: &AppHandle, view: Value) {
    if following() {
        show(app, view);
    }
}

fn checking_view() -> Value {
    json!({ "state": "checking" })
}

fn downloading_view(version: &str, received: u64, total: Option<u64>) -> Value {
    json!({ "state": "downloading", "version": version, "received": received, "total": total })
}

fn ready_view(version: &str) -> Value {
    json!({ "state": "ready", "version": version })
}

fn error_view(title: &str, message: &str) -> Value {
    json!({ "state": "error", "title": title, "message": message })
}

fn up_to_date_view(version: &str) -> Value {
    json!({ "state": "up-to-date", "version": version })
}

/// The prompt. `date` is the release day as YYYY-MM-DD.
fn available_view(version: &str, current: &str, date: Option<String>, notes: &str) -> Value {
    json!({
        "state": "available",
        "version": version,
        "currentVersion": current,
        "releaseDate": date,
        "releaseNotes": notes,
    })
}

/// The window closed, by its close button or after a choice. Mid-check or
/// mid-download that means Cancel; on the prompt, Remind Me Later; on
/// "Ready to Install", install on quit.
pub fn on_window_destroyed(_app: &AppHandle) {
    let mut view = VIEW.lock().unwrap();
    match view["state"].as_str() {
        Some("checking") => {
            GENERATION.fetch_add(1, Ordering::SeqCst);
        }
        Some("downloading") => {
            if let Some(task) = DOWNLOAD_TASK.lock().unwrap().take() {
                task.abort();
            }
        }
        _ => {}
    }
    FOLLOWING.store(false, Ordering::SeqCst);
    *view = Value::Null;
}

// ── Checking ──

/// Development: with `MAGNOLIA_FAKE_UPDATE` set, run a pretend
/// "Check for Updates…" at launch so the window can be seen without a
/// project open.
pub fn preview_at_launch(app: &AppHandle) {
    if fake_mode().is_some() {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            pause(1500).await;
            check_manually(&app, Source::Menu);
        });
    }
}

pub fn schedule_startup_check(app: &AppHandle) {
    if STARTUP_SCHEDULED.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        pause(5000).await;
        run_check(&app, Source::Startup).await;
    });
}

pub fn check_manually(app: &AppHandle, source: Source) {
    if cfg!(debug_assertions) && fake_mode().is_none() {
        match source {
            Source::Preferences => send_status(app, "dev-disabled", None, None),
            _ => show(
                app,
                error_view(
                    "Update checks are disabled in development",
                    "Build a release bundle (npm run tauri build) to test the update flow, or set MAGNOLIA_FAKE_UPDATE=1 to preview this window.",
                ),
            ),
        }
        return;
    }
    // Mid-download or ready to install: that's already the answer.
    if source == Source::Menu
        && matches!(view_state().as_deref(), Some("downloading" | "ready" | "installing"))
    {
        windows::show_update_window(app, false);
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move { run_check(&app, source).await });
}

async fn run_check(app: &AppHandle, source: Source) {
    if source == Source::Menu {
        // A check that's already running (say the startup one) carries on
        // and reports to the window from here; otherwise this one starts
        // at "Checking…".
        FOLLOWING.store(true, Ordering::SeqCst);
        let view = VIEW.lock().unwrap().clone();
        let running = CHECKING.load(Ordering::SeqCst);
        show(app, if running && !view.is_null() { view } else { checking_view() });
    }
    if CHECKING.swap(true, Ordering::SeqCst) {
        return;
    }
    let _guard = CheckGuard;
    if let Some(mode) = fake_mode() {
        return fake_check(app, source, &mode).await;
    }
    if cfg!(debug_assertions) {
        // Dev-only override for exercising the badge UI.
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
    let generation = GENERATION.load(Ordering::SeqCst);
    let cancelled = || GENERATION.load(Ordering::SeqCst) != generation;
    if source == Source::Preferences {
        send_status(app, "checking", None, None);
    }
    let result = async {
        let updater = app.updater().map_err(|e| e.to_string())?;
        updater.check().await.map_err(|e| e.to_string())
    }
    .await;
    if cancelled() {
        return;
    }

    let update = match result {
        Ok(u) => u,
        Err(e) => {
            log::error!("[auto-update] check failed: {e}");
            if source == Source::Preferences {
                send_status(app, "error", None, Some(&e));
            }
            report(app, error_view("Could not check for updates", &e));
            return;
        }
    };
    let Some(update) = update else {
        set_badge(app, None);
        let v = current_version(app);
        if source == Source::Preferences {
            send_status(app, "up-to-date", Some(&v), None);
        }
        report(app, up_to_date_view(&v));
        return;
    };
    set_badge(app, Some(&update.version));
    if source == Source::Preferences {
        send_status(app, "available", Some(&update.version), None);
    }
    // "Skip This Version" silences automatic checks only.
    if source == Source::Startup
        && !following()
        && storage::skipped_version().as_deref() == Some(update.version.as_str())
    {
        return;
    }
    // Downloaded earlier and closed at "Ready to Install": offer the install.
    let downloaded = DOWNLOADED
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|d| d.update.version == update.version);
    if downloaded {
        return show(app, ready_view(&update.version));
    }
    let view = available_view(
        &update.version,
        &update.current_version,
        update
            .date
            .map(|d| format!("{:04}-{:02}-{:02}", d.year(), u8::from(d.month()), d.day())),
        update.body.as_deref().unwrap_or_default(),
    );
    *AVAILABLE.lock().unwrap() = Some(update);
    present(app, source, view);
}

/// Open the prompt. An unprompted (startup) find also gets a notification,
/// in case Magnolia is in the background.
fn present(app: &AppHandle, source: Source, view: Value) {
    if source == Source::Startup && !following() {
        use tauri_plugin_notification::NotificationExt;
        let _ = app
            .notification()
            .builder()
            .title("Magnolia update available")
            .body(format!(
                "Version {} is available.",
                view["version"].as_str().unwrap_or_default()
            ))
            .show();
    }
    show(app, view);
}

// ── Downloading ──

/// Install Update: download in the window, then "Ready to Install".
fn start_download(app: &AppHandle) {
    let mut task = DOWNLOAD_TASK.lock().unwrap();
    if task.as_ref().is_some_and(|t| !t.inner().is_finished()) {
        return;
    }
    let app = app.clone();
    *task = Some(tauri::async_runtime::spawn(async move {
        if fake_mode().is_some() {
            fake_download(&app).await;
        } else {
            download(&app).await;
        }
        DOWNLOAD_TASK.lock().unwrap().take();
    }));
}

async fn download(app: &AppHandle) {
    let Some(update) = AVAILABLE.lock().unwrap().clone() else {
        return;
    };
    show(app, downloading_view(&update.version, 0, None));
    let mut received = 0u64;
    let mut last_tick = Instant::now();
    let progress = |chunk: usize, total: Option<u64>| {
        received += chunk as u64;
        if last_tick.elapsed() >= Duration::from_millis(100) {
            last_tick = Instant::now();
            refresh(app, downloading_view(&update.version, received, total));
        }
    };
    match update.download(progress, || {}).await {
        Ok(bytes) => {
            let version = update.version.clone();
            *DOWNLOADED.lock().unwrap() = Some(Downloaded { update, bytes });
            AVAILABLE.lock().unwrap().take();
            show(app, ready_view(&version));
        }
        Err(e) => {
            log::error!("[auto-update] download failed: {e}");
            show(app, error_view("Could not download the update", &e.to_string()));
        }
    }
}

// ── Installing ──

/// "Ready to Install" closed without installing → it installs as the app quits.
pub fn install_pending_on_quit(_app: &AppHandle) {
    if let Some(d) = DOWNLOADED.lock().unwrap().take()
        && let Err(e) = d.update.install(&d.bytes)
    {
        log::error!("[auto-update] install on quit failed: {e}");
    }
}

pub fn skip(app: &AppHandle, version: &str) {
    storage::set_skipped_version(version);
    let mut available = AVAILABLE.lock().unwrap();
    if available.as_ref().is_some_and(|u| u.version == version) {
        *available = None;
    }
    drop(available);
    let latest = badge_state(app)
        .get("latestVersion")
        .and_then(Value::as_str)
        .map(str::to_string);
    if latest.as_deref() == Some(version) {
        set_badge(app, Some(version));
    }
}

// ── Development stand-ins ──

/// `run_check` on a timer, ending at the prompt (or `=uptodate` / `=error`).
async fn fake_check(app: &AppHandle, source: Source, mode: &str) {
    let generation = GENERATION.load(Ordering::SeqCst);
    let cancelled = || GENERATION.load(Ordering::SeqCst) != generation;
    let current = current_version(app);
    let version = "99.0.0";
    if source == Source::Preferences {
        send_status(app, "checking", None, None);
    }
    pause(1500).await;
    if cancelled() {
        return;
    }
    match mode {
        "uptodate" => {
            if source == Source::Preferences {
                send_status(app, "up-to-date", Some(&current), None);
            }
            return report(app, up_to_date_view(&current));
        }
        "error" => {
            let e = "error sending request for url (https://github.com/caledavis/Magnolia/releases/latest/download/latest.json)";
            if source == Source::Preferences {
                send_status(app, "error", None, Some(e));
            }
            return report(app, error_view("Could not check for updates", e));
        }
        _ => {}
    }
    set_badge(app, Some(version));
    if source == Source::Preferences {
        send_status(app, "available", Some(version), None);
    }
    let notes = "## What's new\n\n\
        - **Word Combinations**: find the phrases and word pairs that recur across your documents.\n\
        - Scope the Document Selector to a single survey.\n\
        - Typing dialogs stay open when you click outside them.\n\n\
        ## Fixes\n\n\
        - Coded text documents no longer re-render on every frame, so long transcripts scroll smoothly.\n\
        - The downloads report counts auto-updater downloads per operating system.";
    present(
        app,
        source,
        available_view(version, &current, Some("2026-11-02".into()), notes),
    );
}

/// `download` on a timer.
async fn fake_download(app: &AppHandle) {
    let version = "99.0.0";
    let total = 48_200_000u64;
    show(app, downloading_view(version, 0, Some(total)));
    for step in 1..=50u64 {
        pause(60).await;
        refresh(app, downloading_view(version, total * step / 50, Some(total)));
    }
    show(app, ready_view(version));
}

// ── Commands ──

#[tauri::command]
pub async fn get_update_badge(app: AppHandle) -> Result<Value, String> {
    Ok(badge_state(&app))
}

#[tauri::command]
pub async fn update_window_state() -> Result<Value, String> {
    Ok(VIEW.lock().unwrap().clone())
}

/// The window's default button: Install Update on the prompt (download),
/// Install and Relaunch once downloaded (save, quit, install, relaunch).
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    match view_state().as_deref() {
        Some("available") => start_download(&app),
        Some("ready") => {
            let version = VIEW.lock().unwrap()["version"].clone();
            show(&app, json!({ "state": "installing", "version": version }));
            if fake_mode().is_some() {
                pause(2000).await;
                windows::close_update_window(&app);
            } else {
                windows::quit_for_update(&app);
            }
        }
        _ => {}
    }
    Ok(())
}

/// The status panel reports how many points its content overflows (or
/// underfills) the window by, so the window fits it.
#[tauri::command]
pub async fn update_window_fit(app: AppHandle, delta: f64) -> Result<(), String> {
    windows::fit_update_status(&app, delta);
    Ok(())
}

#[tauri::command]
pub async fn update_skip(app: AppHandle, version: String) -> Result<(), String> {
    skip(&app, &version);
    windows::close_update_window(&app);
    Ok(())
}

/// Remind Me Later, Cancel and OK: close the window (see
/// `on_window_destroyed` for what closing means at each step).
#[tauri::command]
pub async fn update_dismiss(app: AppHandle) -> Result<(), String> {
    windows::close_update_window(&app);
    Ok(())
}

#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> Result<(), String> {
    check_manually(&app, Source::Preferences);
    Ok(())
}
