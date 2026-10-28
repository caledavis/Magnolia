//! Magnolia desktop app: a Tauri shell around the React renderer, with all
//! project I/O, conversion and system integration in Rust.

mod commands;
mod menu;
mod print;
mod state;
mod storage;
mod updater;
mod windows;

use state::AppState;
use tauri::{AppHandle, Manager, RunEvent};

/// A .qdpx path from the command line (Windows/Linux file association, or a
/// dev launch with a path appended).
fn qdpx_from_args(args: &[String]) -> Option<String> {
    args.iter()
        .skip(1)
        .find(|a| a.to_lowercase().ends_with(".qdpx") && std::path::Path::new(a).exists())
        .cloned()
}

fn open_path(app: &AppHandle, path: String) {
    windows::open_project_in_main(app, &path);
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // A second launch (e.g. double-clicking another .qdpx on
            // Windows/Linux) hands its arguments to this instance.
            match qdpx_from_args(&args) {
                Some(path) => open_path(app, path),
                None => {
                    if let Some(w) = app
                        .get_webview_window(windows::MAIN)
                        .or_else(|| app.get_webview_window(windows::WELCOME))
                    {
                        let _ = w.set_focus();
                    }
                }
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::default())
        .register_uri_scheme_protocol(print::SCHEME, |_ctx, request| {
            let body = print::serve(request.uri().path());
            let builder =
                tauri::http::Response::builder().header("Content-Type", "text/html; charset=utf-8");
            match body {
                Some(html) => builder.status(200).body(html.into_bytes()),
                None => builder.status(404).body(Vec::new()),
            }
            .unwrap()
        })
        .on_menu_event(|app, event| menu::handle_event(app, event.id().as_ref()))
        .invoke_handler(tauri::generate_handler![
            commands::open_project,
            commands::pick_project_file,
            commands::open_project_path,
            commands::set_active_project_path,
            commands::get_file_size,
            commands::read_media,
            commands::read_checkout_marker,
            commands::check_out_project,
            commands::check_in_project,
            commands::read_qdpx_for_compare,
            commands::import_merge_binary,
            commands::read_compare_binary,
            commands::save_project,
            commands::save_project_as,
            commands::create_project_copy,
            commands::create_new_project_file,
            commands::import_text_file,
            commands::read_text_files,
            commands::read_dropped_file,
            commands::reimport_document,
            commands::import_transcript,
            commands::export_pdf,
            commands::export_csv,
            commands::export_svg,
            commands::export_codebook,
            commands::import_codebook,
            commands::open_licence,
            commands::open_acknowledgements,
            commands::open_child_window,
            commands::update_query_results_window,
            commands::get_window_data,
            commands::drain_queued_events,
            commands::raise_other_windows,
            commands::focus_main_window,
            commands::update_panel_visibility,
            commands::flush_complete,
            commands::flush_heartbeat,
            commands::window_title_changed,
            commands::get_recent_projects,
            commands::track_recent_project,
            commands::welcome_action,
            commands::load_preferences,
            commands::save_preferences,
            commands::preferences_update,
            commands::get_app_version,
            updater::get_update_badge,
            updater::update_install,
            updater::update_skip,
            updater::update_remind_later,
            updater::check_for_updates,
        ])
        .setup(|app| {
            storage::init(app.handle());
            menu::rebuild(app.handle());
            // Launched by double-clicking a project (or with a path argument):
            // skip the welcome screen.
            let args: Vec<String> = std::env::args().collect();
            match qdpx_from_args(&args) {
                Some(path) => open_path(app.handle(), path),
                None => {
                    // macOS delivers Finder opens as RunEvent::Opened right
                    // after launch; give it a moment before showing welcome.
                    let handle = app.handle().clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(250));
                        if handle.webview_windows().is_empty() {
                            windows::show_welcome(&handle);
                        }
                    });
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Magnolia");

    app.run(|app, event| match event {
        // Finder double-click / "Open With" on macOS.
        #[cfg(target_os = "macos")]
        RunEvent::Opened { urls } => {
            for url in urls {
                if let Ok(path) = url.to_file_path()
                    && path
                        .extension()
                        .is_some_and(|e| e.eq_ignore_ascii_case("qdpx"))
                {
                    open_path(app, path.to_string_lossy().into_owned());
                }
            }
        }
        // Clicking the Dock icon with no windows open.
        #[cfg(target_os = "macos")]
        RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } => {
            if app
                .webview_windows()
                .keys()
                .all(|l| l.starts_with(print::LABEL_PREFIX))
            {
                windows::show_welcome(app);
            }
        }
        RunEvent::ExitRequested { api, code, .. } => {
            let ui = app.state::<AppState>();
            let quitting = ui.ui.lock().unwrap().is_quitting;
            if code.is_none() && !quitting {
                // The last window closed during main → welcome churn, or on
                // macOS where apps outlive their windows: stay alive. Real
                // quits go through windows::quit, which flushes first and
                // exits with an explicit code.
                api.prevent_exit();
            }
        }
        _ => {}
    });
}
