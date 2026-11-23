//! Small JSON files in the user-data folder: preferences, recent projects,
//! per-project import folders and updater state.
//!
//! The folder is the one the Electron build used (`<config dir>/Magnolia`,
//! e.g. `~/Library/Application Support/Magnolia`), so preferences and the
//! recent-projects list carry over for existing users.

use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};

static DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn init(app: &AppHandle) {
    let base = app
        .path()
        .config_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("Magnolia");
    let base = crate::automation::data_dir().unwrap_or(base);
    let _ = std::fs::create_dir_all(&base);
    let _ = DIR.set(base);
}

pub fn user_data_dir() -> &'static Path {
    DIR.get().expect("storage::init not called")
}

fn file(name: &str) -> PathBuf {
    user_data_dir().join(name)
}

fn read_json(name: &str) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(file(name)).ok()?).ok()
}

fn write_json(name: &str, v: &Value, pretty: bool) {
    let text = if pretty {
        serde_json::to_string_pretty(v)
    } else {
        serde_json::to_string(v)
    }
    .unwrap_or_default();
    if let Err(e) = write_atomically(&file(name), text.as_bytes()) {
        log::warn!("could not save {name}: {e}");
    }
}

/// Replace `path` with `bytes` all at once: write a temporary file beside
/// it, flush it to disk, then rename it over. A crash or a full disk leaves
/// the old file whole rather than half-written (and, for the preferences,
/// the user's name — the project lock's identity — lost with it).
fn write_atomically(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let tmp = path.with_extension(format!(
        "{}.{}.tmp",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

// ── Preferences ──

const PREFS: &str = "magnolia-preferences.json";

pub fn load_preferences() -> Value {
    read_json(PREFS).unwrap_or(Value::Null)
}

pub fn save_preferences(prefs: &Value) {
    write_json(PREFS, prefs, true);
}

/// The user's display name, stamped into magnolia-editor.json on save.
pub fn editor_name() -> String {
    load_preferences()
        .get("userName")
        .and_then(Value::as_str)
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

/// Export paper size from Preferences (A4 default).
pub fn paper_size() -> String {
    const VALID: &[&str] = &["A4", "A3", "A5", "Letter", "Legal", "Tabloid"];
    load_preferences()
        .get("paperSize")
        .and_then(Value::as_str)
        .filter(|s| VALID.contains(s))
        .unwrap_or("A4")
        .to_string()
}

// ── Recent projects ──

const RECENTS: &str = "recent-projects.json";

pub fn load_recent_projects() -> Vec<Value> {
    read_json(RECENTS)
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
}

fn save_recents(list: &[Value]) {
    write_json(RECENTS, &Value::Array(list.to_vec()), false);
}

pub fn track_recent_project(name: &str, path: &str) {
    let mut list: Vec<Value> = load_recent_projects()
        .into_iter()
        .filter(|r| r.get("path").and_then(Value::as_str) != Some(path))
        .collect();
    list.insert(0, json!({ "name": name, "path": path }));
    list.truncate(10);
    save_recents(&list);
}

/// Drop entries whose file no longer exists and return the live ones.
pub fn prune_recent_projects() -> Vec<Value> {
    let all = load_recent_projects();
    let live: Vec<Value> = all
        .iter()
        .filter(|r| {
            r.get("path")
                .and_then(Value::as_str)
                .is_some_and(|p| Path::new(p).exists())
        })
        .cloned()
        .collect();
    if live.len() != all.len() {
        save_recents(&live);
    }
    live
}

pub fn remove_recent_project(path: &str) {
    let list: Vec<Value> = load_recent_projects()
        .into_iter()
        .filter(|r| r.get("path").and_then(Value::as_str) != Some(path))
        .collect();
    save_recents(&list);
}

pub fn clear_recent_projects() {
    save_recents(&[]);
}

// ── Last import folder per project ──

const IMPORT_DIRS: &str = "magnolia-import-dirs.json";

/// The folder the last import for this project came from, if it still
/// exists (it may be on an unmounted drive by now).
pub fn last_import_dir(project: Option<&str>) -> Option<PathBuf> {
    let dir = read_json(IMPORT_DIRS)?.get(project?)?.as_str()?.to_string();
    let p = PathBuf::from(dir);
    p.exists().then_some(p)
}

pub fn set_last_import_dir(project: Option<&str>, dir: &Path) {
    let Some(project) = project else { return };
    let mut all = read_json(IMPORT_DIRS)
        .filter(Value::is_object)
        .unwrap_or(json!({}));
    all[project] = dir.to_string_lossy().into();
    write_json(IMPORT_DIRS, &all, true);
}

// ── Window layout ──

const WINDOW_LAYOUT: &str = "magnolia-window-layout.json";

/// Whether Query Results was popped out of the main window when that
/// window last closed (windows.rs), so the next project opens it popped
/// out again — e.g. on a second screen. Where each window sat is kept by
/// the window-state plugin.
pub fn query_results_popped_out() -> bool {
    read_json(WINDOW_LAYOUT)
        .and_then(|v| v.get("queryResultsPoppedOut")?.as_bool())
        .unwrap_or(false)
}

pub fn set_query_results_popped_out(popped_out: bool) {
    write_json(WINDOW_LAYOUT, &json!({ "queryResultsPoppedOut": popped_out }), true);
}

/// Each remembered window's last size in points (windows.rs).
const WINDOW_SIZES: &str = "magnolia-window-sizes.json";

pub fn window_sizes() -> serde_json::Map<String, Value> {
    match read_json(WINDOW_SIZES) {
        Some(Value::Object(m)) => m,
        _ => serde_json::Map::new(),
    }
}

pub fn save_window_sizes(sizes: &serde_json::Map<String, Value>) {
    write_json(WINDOW_SIZES, &Value::Object(sizes.clone()), true);
}

// ── Updater state ──

const UPDATE_STATE: &str = "magnolia-update-state.json";

pub fn skipped_version() -> Option<String> {
    read_json(UPDATE_STATE)?
        .get("skippedVersion")?
        .as_str()
        .map(str::to_string)
}

pub fn set_skipped_version(v: &str) {
    write_json(UPDATE_STATE, &json!({ "skippedVersion": v }), true);
}

#[cfg(test)]
mod tests {
    use super::write_atomically;

    #[test]
    fn replaces_the_file_whole_and_leaves_nothing_behind() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("magnolia-preferences.json");
        std::fs::write(&path, "old").unwrap();
        write_atomically(&path, b"{\"new\":true}").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"new\":true}");
        let names: Vec<_> = std::fs::read_dir(d.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names.len(), 1, "{names:?}");
    }

    #[test]
    fn a_failed_write_keeps_the_old_file() {
        let d = tempfile::tempdir().unwrap();
        // The target's folder is missing: the write fails before any rename.
        let path = d.path().join("gone").join("prefs.json");
        assert!(write_atomically(&path, b"x").is_err());
        assert!(!path.exists());
    }
}
