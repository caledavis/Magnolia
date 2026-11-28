//! Which files the page may have read or written by path.
//!
//! The page asks for files by path (an import the user picked, the open
//! project, a media file). If a script ever got into the page — through a
//! memo or a document in a project someone shared, say — it could ask for
//! any path, so the backend doesn't take the page's word for it:
//!
//! - Files the user chose are *granted*: picked in a dialog, dropped on the
//!   window, attached in Zotero, or a project Magnolia itself opened,
//!   created or saved (whose path it then handed to the page). Only these
//!   can be imported or read as media.
//! - Only projects the user opened, created or saved are *writable*: chosen
//!   in an Open or Save dialog, made with New Project, opened from the file
//!   manager or command line, or from the recent list. Only these can be
//!   opened as the project, saved over, or checked out and in — and only if
//!   they're `.qdpx` files, so an imported interview can never be replaced
//!   by a project archive.
//! - Any project file (`.qdpx`) may be read, for comparing coders'
//!   projects, merging and checking locks: saved Inter-coder Agreement
//!   analyses keep their projects' paths in the project, from earlier
//!   sessions. A .qdpx yields only project data, never other files.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

static GRANTED: LazyLock<Mutex<HashSet<PathBuf>>> = LazyLock::new(|| Mutex::new(HashSet::new()));
static WRITABLE: LazyLock<Mutex<HashSet<PathBuf>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

/// One spelling per file: resolved if it exists (so `a/../b` and links
/// match), as given if it doesn't yet (a project about to be created).
fn key(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn add(set: &Mutex<HashSet<PathBuf>>, path: &Path) {
    let mut set = set.lock().unwrap();
    set.insert(path.to_path_buf());
    set.insert(key(path));
}

fn holds(set: &Mutex<HashSet<PathBuf>>, path: &Path) -> bool {
    let set = set.lock().unwrap();
    set.contains(path) || set.contains(&key(path))
}

/// The user chose this file (or Magnolia made it for them).
pub fn grant(path: impl AsRef<Path>) {
    add(&GRANTED, path.as_ref());
}

pub fn is_granted(path: impl AsRef<Path>) -> bool {
    holds(&GRANTED, path.as_ref())
}

/// The user opened, created or saved this project themselves, so it's
/// theirs to save over (and to read). Only for a `.qdpx` file; anything
/// else is granted for reading only.
pub fn grant_project(path: impl AsRef<Path>) {
    let path = path.as_ref();
    add(&GRANTED, path);
    if is_project(path) {
        add(&WRITABLE, path);
    }
}

fn is_writable_project(path: &Path) -> bool {
    is_project(path) && holds(&WRITABLE, path)
}

/// A project file, by its extension.
pub fn is_project(path: impl AsRef<Path>) -> bool {
    path.as_ref()
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("qdpx"))
}

/// Refused: the page asked for a file the user didn't choose.
pub fn refused(path: &Path) -> String {
    log::warn!("refused access to {}", path.display());
    format!("Magnolia can't open “{}” here.", path.display())
}

/// A file the user chose, for importing, reading or saving over.
pub fn check_granted(path: impl AsRef<Path>) -> Result<(), String> {
    let path = path.as_ref();
    if is_granted(path) { Ok(()) } else { Err(refused(path)) }
}

/// A project the user opened, created or saved: to open as the project,
/// save over, or check out and in.
pub fn check_writable_project(path: impl AsRef<Path>) -> Result<(), String> {
    let path = path.as_ref();
    if is_writable_project(path) { Ok(()) } else { Err(refused(path)) }
}

/// A project file, for reading.
pub fn check_project(path: impl AsRef<Path>) -> Result<(), String> {
    let path = path.as_ref();
    if is_project(path) { Ok(()) } else { Err(refused(path)) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grants_by_file_however_the_path_is_written() {
        let d = tempfile::tempdir().unwrap();
        let file = d.path().join("chosen.txt");
        std::fs::write(&file, "x").unwrap();
        assert!(!is_granted(&file));
        grant(&file);
        assert!(is_granted(&file));
        // The same file by another spelling.
        let roundabout = d.path().join("sub/../chosen.txt");
        std::fs::create_dir(d.path().join("sub")).unwrap();
        assert!(is_granted(&roundabout));
        assert!(!is_granted(d.path().join("other.txt")));
        assert!(check_granted(d.path().join("other.txt")).is_err());
    }

    #[test]
    fn grants_a_project_before_it_exists() {
        let d = tempfile::tempdir().unwrap();
        let new = d.path().join("New.qdpx");
        grant(&new);
        std::fs::write(&new, "x").unwrap();
        assert!(is_granted(&new));
    }

    #[test]
    fn only_projects_the_user_opened_are_writable() {
        let d = tempfile::tempdir().unwrap();
        let interview = d.path().join("interview.docx");
        std::fs::write(&interview, "x").unwrap();
        // Imported (or dropped, or a Zotero attachment): readable, never
        // saved over or checked out, even if asked to as a project.
        grant(&interview);
        assert!(check_writable_project(&interview).is_err());
        grant_project(&interview);
        assert!(check_writable_project(&interview).is_err());
        assert!(is_granted(&interview));

        // Another coder's project, read for comparison: not writable.
        let theirs = d.path().join("Theirs.qdpx");
        std::fs::write(&theirs, "x").unwrap();
        assert!(check_project(&theirs).is_ok());
        assert!(check_writable_project(&theirs).is_err());
        grant(&theirs);
        assert!(check_writable_project(&theirs).is_err());

        // One the user opened: writable, by any spelling.
        let mine = d.path().join("Mine.qdpx");
        std::fs::write(&mine, "x").unwrap();
        grant_project(&mine);
        assert!(check_writable_project(&mine).is_ok());
        std::fs::create_dir(d.path().join("sub")).unwrap();
        assert!(check_writable_project(d.path().join("sub/../Mine.qdpx")).is_ok());
        assert!(is_granted(&mine));
    }

    #[test]
    fn projects_are_known_by_extension() {
        assert!(check_project("/somewhere/Study.QDPX").is_ok());
        assert!(check_project("/Users/me/.ssh/id_rsa").is_err());
        assert!(check_project("/somewhere/notes.qdpx.txt").is_err());
    }
}
