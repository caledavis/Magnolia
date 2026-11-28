//! WebKitGTK settings every Magnolia webview needs on Linux, applied once
//! per webview as its first page starts loading (`setup_webview`).

use gtk::prelude::*;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use webkit2gtk::{WebContextExt, WebViewExt};

/// Files in the drag the user most recently brought over a window, not
/// yet imported, and when they were last asked for.
static DRAGGED: Mutex<Dragged> = Mutex::new(Dragged { paths: Vec::new(), at: None });

/// How long a drag's files stay on offer after it, or after the last of
/// them was asked for. Each file of a drop is asked for in turn, after the
/// one before has been imported (a long video can take a few minutes);
/// after this, nothing is left that `dropped_file_path` could hand out —
/// not even the files of a drag that was brought over and taken away.
const DRAG_LIFETIME: Duration = Duration::from_secs(10 * 60);

struct Dragged {
    paths: Vec<PathBuf>,
    at: Option<Instant>,
}

impl Dragged {
    /// The dragged file `matches` picks, taken off the list so it's handed
    /// out once.
    fn take(&mut self, now: Instant, matches: impl Fn(&Path) -> bool) -> Option<PathBuf> {
        if self.at.is_none_or(|at| now.duration_since(at) > DRAG_LIFETIME) {
            self.paths.clear();
            return None;
        }
        let i = self.paths.iter().position(|p| matches(p))?;
        self.at = Some(now);
        Some(self.paths.remove(i))
    }
}

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
                *DRAGGED.lock().unwrap() = Dragged { paths, at: Some(Instant::now()) };
            }
        });
    });
}

/// The file of the most recent drag (see `setup_webview`) that `matches`
/// picks, if it's still on offer; each is given only once.
pub fn take_dragged(matches: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    DRAGGED.lock().unwrap().take(Instant::now(), matches)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dragged_files_are_given_once_and_not_for_long() {
        let start = Instant::now();
        let mut d = Dragged { paths: vec!["/a/one.mp4".into(), "/a/two.mp4".into()], at: Some(start) };
        let named = |n: &'static str| move |p: &Path| p.file_name().is_some_and(|f| f == n);
        assert_eq!(d.take(start, named("two.mp4")), Some("/a/two.mp4".into()));
        assert_eq!(d.take(start, named("two.mp4")), None);
        // Asking keeps the rest on offer a while longer.
        let later = start + DRAG_LIFETIME - Duration::from_secs(1);
        assert_eq!(d.take(later, named("nothing")), None);
        let much_later = later + DRAG_LIFETIME + Duration::from_secs(1);
        assert_eq!(d.take(much_later, named("one.mp4")), None);
        assert!(d.paths.is_empty());
    }
}
