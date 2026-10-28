//! Window lifecycle: the welcome screen, the main project window and the
//! pop-out child windows (codebook, logbook, memos, query results), plus the
//! flush-on-close handshake and quitting.

use crate::menu;
use crate::state::AppState;
use serde_json::{Value, json};
use std::time::Duration;
use tauri::{
    AppHandle, Emitter, EventTarget, LogicalPosition, Manager, PhysicalSize, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

pub const MAIN: &str = "main";
pub const WELCOME: &str = "welcome";
pub const CODEBOOK: &str = "codebook";
pub const LOGBOOK: &str = "logbook";
pub const QUERY_RESULTS: &str = "query-results";
const MEMO_PREFIX: &str = "memo-";

/// How long the renderer may stay silent mid-flush before the main window is
/// force-closed. Each heartbeat pushes the deadline back.
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(4);

fn state(app: &AppHandle) -> &AppState {
    app.state::<AppState>().inner()
}

/// Send an event to one window.
pub fn emit_to(app: &AppHandle, label: &str, event: &str, payload: impl serde::Serialize + Clone) {
    let _ = app.emit_to(EventTarget::webview_window(label), event, payload);
}

/// Send to a window once its renderer is listening for `event` (see
/// `UiState::queued_events`). Used for messages to a window that may still
/// be loading.
pub fn emit_when_ready(app: &AppHandle, label: &str, event: &str, payload: Value) {
    state(app)
        .ui
        .lock()
        .unwrap()
        .queued_events
        .entry((label.to_string(), event.to_string()))
        .or_default()
        .push(payload);
    // Also emit now: if the listener is already up it gets it immediately and
    // the drain the renderer does on (re)subscribe finds the queue cleared.
    emit_to(
        app,
        label,
        "queued-event-available",
        json!({ "event": event }),
    );
}

pub fn drain_queued(app: &AppHandle, label: &str, event: &str) -> Vec<Value> {
    state(app)
        .ui
        .lock()
        .unwrap()
        .queued_events
        .remove(&(label.to_string(), event.to_string()))
        .unwrap_or_default()
}

fn app_url(page: &str) -> WebviewUrl {
    WebviewUrl::App(page.into())
}

/// External links open in the browser; the app never navigates away.
fn is_app_url(url: &tauri::Url) -> bool {
    matches!(url.scheme(), "tauri" | "asset" | "about" | "data" | "blob")
        || url
            .host_str()
            .is_some_and(|h| h == "localhost" || h == "tauri.localhost" || h == "127.0.0.1")
}

fn base_builder<'a>(
    app: &'a AppHandle,
    label: &'a str,
    page: &str,
) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    let handle = app.clone();
    WebviewWindowBuilder::new(app, label, app_url(page))
        // Keep HTML5 drag-and-drop (codes, documents, OS file drops) in the
        // page; the native handler would swallow it.
        .disable_drag_drop_handler()
        .visible(false)
        .on_page_load(|w, p| {
            if matches!(p.event(), tauri::webview::PageLoadEvent::Finished) {
                let _ = w.show();
            }
        })
        .on_navigation(move |url| {
            if is_app_url(url) {
                return true;
            }
            if matches!(url.scheme(), "http" | "https" | "mailto") {
                use tauri_plugin_opener::OpenerExt;
                let _ = handle.opener().open_url(url.as_str(), None::<&str>);
            }
            false
        })
}

/// Chromeless on every platform: macOS keeps its traffic lights inset into
/// the page; Windows/Linux draw their own controls in the toolbar. `lights_y`
/// is handed to tao; `None` leaves the lights to `keep_traffic_lights_placed`.
fn chromeless<'a>(
    b: WebviewWindowBuilder<'a, tauri::Wry, AppHandle>,
    lights_y: Option<f64>,
) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    #[cfg(target_os = "macos")]
    {
        let b = b
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
        match lights_y {
            Some(y) => b.traffic_light_position(LogicalPosition::new(20.0, y)),
            None => b,
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (lights_y, LogicalPosition::<f64>::new(0.0, 0.0));
        b.decorations(false)
    }
}

/// Main-window traffic-light offset (close button's top-left, in points from
/// the window's top-left): y=20 centres the 14px light cluster in the 54px
/// toolbar.
const MAIN_LIGHTS: (f64, f64) = (20.0, 20.0);

/// Place the main window's traffic lights ourselves rather than through
/// tao: tao's layout leaves the cluster 9pt above the toolbar's centre line
/// and re-applies itself on redraw. AppKit puts the buttons back at the top
/// on title changes, resizes and focus changes, so place them after each.
fn keep_traffic_lights_placed(w: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        place_traffic_lights(w);
        let (app, label) = (w.app_handle().clone(), w.label().to_string());
        w.on_window_event(move |e| {
            if matches!(
                e,
                WindowEvent::Resized(_)
                    | WindowEvent::Focused(_)
                    | WindowEvent::ThemeChanged(_)
                    | WindowEvent::ScaleFactorChanged { .. }
            ) && let Some(w) = app.get_webview_window(&label)
            {
                place_traffic_lights(&w);
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (w, MAIN_LIGHTS);
}

/// Move the main window's traffic lights to `MAIN_LIGHTS` (other windows
/// keep tao's placement).
pub fn place_traffic_lights(w: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    if w.label() == MAIN {
        let app = w.app_handle().clone();
        let _ = app.clone().run_on_main_thread(move || {
            let Some(ns_window) = app
                .get_webview_window(MAIN)
                .and_then(|w| w.ns_window().ok())
            else {
                return;
            };
            // SAFETY: looked up on the main thread, where the window is
            // owned and closed, so it is alive for this call.
            unsafe { inset_traffic_lights(&*(ns_window as *const objc2_app_kit::NSWindow)) }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = w;
}

/// Grow the title-bar container to `y` above and below the buttons, then
/// centre them in it and space them from `x`, keeping AppKit's spacing.
#[cfg(target_os = "macos")]
fn inset_traffic_lights(window: &objc2_app_kit::NSWindow) {
    use objc2_app_kit::NSWindowButton;
    let (x, y) = MAIN_LIGHTS;
    let buttons = [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ]
    .map(|b| window.standardWindowButton(b));
    let [Some(close), Some(mini), Some(zoom)] = buttons else {
        return;
    };
    // SAFETY: plain view-hierarchy reads on the main thread.
    let Some(container) = (unsafe { close.superview().and_then(|v| v.superview()) }) else {
        return;
    };
    let close_rect = close.frame();
    let mut bar = container.frame();
    bar.size.height = close_rect.size.height + 2.0 * y;
    bar.origin.y = window.frame().size.height - bar.size.height;
    container.setFrame(bar);
    let spacing = mini.frame().origin.x - close_rect.origin.x;
    for (i, button) in [close, mini, zoom].iter().enumerate() {
        let mut origin = button.frame().origin;
        origin.x = x + i as f64 * spacing;
        origin.y = y;
        button.setFrameOrigin(origin);
    }
}

pub fn show_welcome(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(WELCOME) {
        let _ = w.set_focus();
        return;
    }
    let b = base_builder(app, WELCOME, "welcome.html")
        .title("Magnolia")
        .inner_size(720.0, 520.0)
        .resizable(false)
        .maximizable(false)
        .center();
    match chromeless(b, Some(20.0)).build() {
        Ok(w) => {
            let handle = app.clone();
            w.on_window_event(move |e| {
                if let WindowEvent::Destroyed = e {
                    on_welcome_destroyed(&handle);
                }
            });
        }
        Err(e) => log::error!("could not open welcome window: {e}"),
    }
    menu::rebuild(app);
}

/// Closing the welcome screen by hand (not to open a project) quits on
/// Windows/Linux; macOS apps conventionally stay running.
fn on_welcome_destroyed(app: &AppHandle) {
    let replacing = std::mem::take(&mut state(app).ui.lock().unwrap().replacing_welcome);
    if replacing || app.get_webview_window(MAIN).is_some() {
        return;
    }
    if !cfg!(target_os = "macos") {
        quit(app);
    }
}

fn close_welcome(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(WELCOME) {
        state(app).ui.lock().unwrap().replacing_welcome = true;
        let _ = w.destroy();
    }
}

/// Open (or focus) the main window, closing the welcome screen.
pub fn open_main(app: &AppHandle) -> Option<WebviewWindow> {
    close_welcome(app);
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.set_focus();
        return Some(w);
    }
    {
        let mut ui = state(app).ui.lock().unwrap();
        ui.flush_pending = false;
        ui.is_quitting = false;
    }
    let height = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| {
            let PhysicalSize { height, .. } = m.work_area().size;
            height as f64 / m.scale_factor()
        })
        .unwrap_or(900.0);
    let b = base_builder(app, MAIN, "index.html")
        .title("Magnolia")
        .inner_size(1400.0, height)
        .min_inner_size(900.0, 600.0)
        .center();
    #[cfg(target_os = "macos")]
    let b = b.accept_first_mouse(true);
    let w = match chromeless(b, None).build() {
        Ok(w) => w,
        Err(e) => {
            log::error!("could not open main window: {e}");
            return None;
        }
    };
    keep_traffic_lights_placed(&w);
    let handle = app.clone();
    w.on_window_event(move |e| match e {
        WindowEvent::CloseRequested { api, .. } => {
            let mut ui = state(&handle).ui.lock().unwrap();
            if ui.flush_pending {
                return;
            }
            // Ask the renderer to save, then finish the close once it acks
            // (flush_complete) — or force it if it goes silent.
            api.prevent_close();
            ui.flush_pending = true;
            drop(ui);
            emit_to(&handle, MAIN, "flush-and-close", ());
            arm_flush_watchdog(&handle);
        }
        WindowEvent::Destroyed => on_main_destroyed(&handle),
        _ => {}
    });
    crate::updater::schedule_startup_check(app);
    menu::rebuild(app);
    Some(w)
}

/// Re-arm the flush watchdog; it fires only after a full timeout of renderer
/// silence, so a long save on a big project keeps extending it.
pub fn arm_flush_watchdog(app: &AppHandle) {
    let generation = {
        let mut ui = state(app).ui.lock().unwrap();
        if !ui.flush_pending {
            return;
        }
        ui.flush_generation += 1;
        ui.flush_generation
    };
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(HEARTBEAT_TIMEOUT);
        let ui = state(&handle).ui.lock().unwrap();
        if ui.flush_pending && ui.flush_generation == generation {
            drop(ui);
            log::warn!("renderer went silent during flush-on-close; closing anyway");
            if let Some(w) = handle.get_webview_window(MAIN) {
                let _ = w.destroy();
            }
        }
    });
}

/// Renderer finished its flush-on-close save.
pub fn flush_complete(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.destroy();
    }
}

fn on_main_destroyed(app: &AppHandle) {
    let (quitting, restart) = {
        let mut ui = state(app).ui.lock().unwrap();
        ui.flush_pending = false;
        ui.flush_generation += 1;
        ui.window_data.clear();
        ui.queued_events.retain(|(label, _), _| label != MAIN);
        (ui.is_quitting, ui.restart_after_quit)
    };
    for (label, w) in app.webview_windows() {
        if label != WELCOME && label != MAIN {
            let _ = w.destroy();
        }
    }
    if quitting {
        crate::updater::install_pending_on_quit(app);
        if restart {
            app.restart();
        }
        app.exit(0);
    } else {
        show_welcome(app);
    }
}

/// Quit: let the main window flush first, then exit.
pub fn quit(app: &AppHandle) {
    state(app).ui.lock().unwrap().is_quitting = true;
    match app.get_webview_window(MAIN) {
        Some(w) => {
            let _ = w.close();
        }
        None => {
            crate::updater::install_pending_on_quit(app);
            if state(app).ui.lock().unwrap().restart_after_quit {
                app.restart();
            }
            app.exit(0);
        }
    }
}

/// Install the downloaded update: flush and quit, install, relaunch.
pub fn quit_for_update(app: &AppHandle) {
    state(app).ui.lock().unwrap().restart_after_quit = true;
    quit(app);
}

/// Open the project at `path` in the main window (creating it if needed).
pub fn open_project_in_main(app: &AppHandle, path: &str) {
    if open_main(app).is_some() {
        emit_when_ready(app, MAIN, "open-recent-project", json!(path));
    }
}

// ── Child windows ──

struct ChildSpec {
    page: &'static str,
    title: &'static str,
    size: (f64, f64),
    min: (f64, f64),
    init_event: &'static str,
}

fn open_child(app: &AppHandle, label: &str, spec: ChildSpec, data: Value) {
    state(app)
        .ui
        .lock()
        .unwrap()
        .window_data
        .insert(label.to_string(), data.clone());
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.set_focus();
        emit_to(app, label, spec.init_event, data);
        return;
    }
    let b = base_builder(app, label, spec.page)
        .title(spec.title)
        .inner_size(spec.size.0, spec.size.1)
        .min_inner_size(spec.min.0, spec.min.1);
    match b.build() {
        Ok(w) => {
            let handle = app.clone();
            let label = label.to_string();
            w.on_window_event(move |e| {
                if let WindowEvent::Destroyed = e {
                    state(&handle).ui.lock().unwrap().window_data.remove(&label);
                    if label == QUERY_RESULTS {
                        emit_to(&handle, MAIN, "query-results-window-closed", ());
                    }
                    menu::rebuild(&handle);
                }
            });
            menu::rebuild(app);
        }
        Err(e) => log::error!("could not open {label} window: {e}"),
    }
}

pub fn open_codebook(app: &AppHandle, data: Value) {
    let spec = ChildSpec {
        page: "codebook.html",
        title: "Codes",
        size: (650.0, 700.0),
        min: (450.0, 400.0),
        init_event: "codebook-init-data",
    };
    open_child(app, CODEBOOK, spec, data);
}

pub fn open_logbook(app: &AppHandle, data: Value) {
    let spec = ChildSpec {
        page: "logbook.html",
        title: "Logbook",
        size: (650.0, 700.0),
        min: (450.0, 400.0),
        init_event: "logbook-init-data",
    };
    open_child(app, LOGBOOK, spec, data);
}

pub fn open_query_results(app: &AppHandle, data: Value) {
    let spec = ChildSpec {
        page: "query-results.html",
        title: "Queries",
        size: (900.0, 600.0),
        min: (500.0, 300.0),
        init_event: "query-results-init-data",
    };
    open_child(app, QUERY_RESULTS, spec, data);
}

pub fn update_query_results(app: &AppHandle, data: Value) {
    state(app)
        .ui
        .lock()
        .unwrap()
        .window_data
        .insert(QUERY_RESULTS.into(), data.clone());
    if app.get_webview_window(QUERY_RESULTS).is_some() {
        emit_to(app, QUERY_RESULTS, "query-results-init-data", data);
    }
}

/// One window per memo; labels allow only `[a-zA-Z0-9-/:_]`.
pub fn open_memo(app: &AppHandle, data: Value) {
    let guid = data
        .pointer("/memo/guid")
        .and_then(Value::as_str)
        .unwrap_or("memo");
    let safe: String = guid
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let label = format!("{MEMO_PREFIX}{safe}");
    let spec = ChildSpec {
        page: "memo-edit.html",
        title: "Memos",
        size: (550.0, 500.0),
        min: (400.0, 350.0),
        init_event: "memo-edit-init-data",
    };
    open_child(app, &label, spec, data);
}

pub fn window_data(app: &AppHandle, label: &str) -> Value {
    state(app)
        .ui
        .lock()
        .unwrap()
        .window_data
        .get(label)
        .cloned()
        .unwrap_or(Value::Null)
}

/// When a drag starts in the main window, raise every other window so their
/// drop targets are reachable, focusing the topmost.
pub fn raise_other_windows(app: &AppHandle, source: &str) {
    // Focusing each in turn raises them all; the last one keeps focus.
    for (label, w) in app.webview_windows() {
        if label != source && label != WELCOME {
            let _ = w.set_focus();
        }
    }
}
