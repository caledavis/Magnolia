//! Screenshot automation for the manual and website (development builds
//! only; inert in release builds).
//!
//! `MAGNOLIA_AUTOMATION=<script.js>` runs the script in the main window
//! when its page loads. The script drives the page like a user would and
//! calls the commands below to size the window, capture it and quit.
//! `MAGNOLIA_AUTOMATION_DATA=<dir>` keeps preferences and recent projects
//! out of the real user-data folder. An automated run also skips the
//! single-instance handoff, so it never sends its scratch project to a
//! Magnolia the user has open.

use tauri::{AppHandle, LogicalSize, WebviewWindow};

/// Whether this is an automated run.
pub fn active() -> bool {
    cfg!(debug_assertions) && std::env::var_os("MAGNOLIA_AUTOMATION").is_some()
}

/// The script to run in the main window, if this is an automated run.
pub fn script() -> Option<String> {
    if !active() {
        return None;
    }
    let path = std::env::var("MAGNOLIA_AUTOMATION").ok()?;
    match std::fs::read_to_string(&path) {
        Ok(s) => Some(s),
        Err(e) => {
            log::error!("automation script {path}: {e}");
            None
        }
    }
}

/// Where preferences go during an automated run.
pub fn data_dir() -> Option<std::path::PathBuf> {
    if !active() {
        return None;
    }
    std::env::var_os("MAGNOLIA_AUTOMATION_DATA").map(Into::into)
}

fn check() -> Result<(), String> {
    if active() {
        Ok(())
    } else {
        Err("automation is only available in an automated development run".into())
    }
}

/// Resize the window's content area (in points).
#[tauri::command]
pub fn automation_set_size(window: WebviewWindow, width: f64, height: f64) -> Result<(), String> {
    check()?;
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|e| e.to_string())
}

/// Capture the window, without its shadow, to a PNG: the calling window,
/// or the window labelled `label` (a pop-out such as `memos`).
#[tauri::command]
pub fn automation_capture(
    app: tauri::AppHandle,
    window: WebviewWindow,
    path: String,
    label: Option<String>,
) -> Result<(), String> {
    check()?;
    let window = match label {
        Some(l) => tauri::Manager::get_webview_window(&app, &l).ok_or(format!("no window {l}"))?,
        None => window,
    };
    #[cfg(target_os = "macos")]
    {
        let ns = window.ns_window().map_err(|e| e.to_string())? as *const objc2_app_kit::NSWindow;
        // A window's number is its CGWindowID, which screencapture takes.
        let id = unsafe { (*ns).windowNumber() };
        let status = std::process::Command::new("screencapture")
            .args(["-x", "-o", &format!("-l{id}"), &path])
            .status()
            .map_err(|e| e.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("screencapture failed: {status}"))
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, path);
        Err("window capture is only implemented on macOS".into())
    }
}

/// Run `script` in the window labelled `label` (a pop-out such as `memos`),
/// so automation can click in windows its own script doesn't run in.
#[tauri::command]
pub fn automation_eval(app: tauri::AppHandle, label: String, script: String) -> Result<(), String> {
    check()?;
    tauri::Manager::get_webview_window(&app, &label)
        .ok_or(format!("no window {label}"))?
        .eval(&script)
        .map_err(|e| e.to_string())
}

/// Print a line to the terminal running the automation.
#[tauri::command]
pub fn automation_log(message: String) -> Result<(), String> {
    check()?;
    eprintln!("[automation] {message}");
    Ok(())
}

/// End the run.
#[tauri::command]
pub fn automation_quit(app: AppHandle) -> Result<(), String> {
    check()?;
    app.exit(0);
    Ok(())
}
