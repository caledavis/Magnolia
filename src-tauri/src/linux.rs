//! WebKitGTK settings every Magnolia webview needs on Linux, applied once
//! per webview as its first page starts loading (`setup_webview`).

use gtk::prelude::*;
use std::path::PathBuf;
use std::sync::Mutex;
use webkit2gtk::{WebContextExt, WebViewExt};

/// Files in the drag the user most recently brought over a window.
static DRAGGED: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

const SET_UP: &str = "magnolia-set-up";

pub fn setup_webview<R: tauri::Runtime>(webview: &tauri::Webview<R>) {
    let _ = webview.with_webview(|pv| {
        let view = pv.inner();
        // SAFETY: a marker only ever read back as the same type, here.
        unsafe {
            if view.data::<bool>(SET_UP).is_some() {
                return;
            }
            view.set_data(SET_UP, true);
        }
        // Underline misspelt words as you type, as macOS does (lib.rs,
        // enable_spell_checking). WebKitGTK leaves it off; with no
        // languages given it checks in the system's language.
        if let Some(context) = view.context() {
            context.set_spell_checking_enabled(true);
        }
        // The page sees a dropped file's name and size but not where it
        // is, so to import a long video it would have to read all of it
        // into memory and send it over IPC. The drag's own data has the
        // paths: note them for `dropped_file_path`, and leave the drop to
        // WebKit and the page.
        view.connect_drag_data_received(|_, _, _, _, data, _, _| {
            let paths: Vec<PathBuf> = data
                .uris()
                .iter()
                .filter_map(|uri| gtk::glib::filename_from_uri(uri).ok().map(|(path, _)| path))
                .collect();
            if !paths.is_empty() {
                *DRAGGED.lock().unwrap() = paths;
            }
        });
    });
}

/// The files of the most recent drag (see `setup_webview`).
pub fn dragged_paths() -> Vec<PathBuf> {
    DRAGGED.lock().unwrap().clone()
}
