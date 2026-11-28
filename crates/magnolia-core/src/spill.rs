//! A folder for this run's large binaries that aren't in a project yet
//! (fresh imports of audio and video, compressed media unpacked to be
//! streamed), so they sit on disk rather than in memory.
//!
//! Each running Magnolia has its own subfolder of `<temp>/Magnolia Imports`,
//! with a `.lock` file it holds locked for as long as it runs. Folders whose
//! lock nobody holds were left by a run that has ended (or crashed), and the
//! next run clears them away.

use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

struct SpillDir {
    dir: PathBuf,
    /// Held (locked) for the life of the process.
    _lock: File,
}

static SPILL: OnceLock<Option<SpillDir>> = OnceLock::new();

const LOCK: &str = ".lock";

fn base() -> PathBuf {
    std::env::temp_dir().join("Magnolia Imports")
}

fn create() -> Option<SpillDir> {
    let base = base();
    std::fs::create_dir_all(&base).ok()?;
    sweep(&base);
    let dir = base.join(crate::util::new_guid());
    std::fs::create_dir_all(&dir).ok()?;
    let lock = File::create(dir.join(LOCK)).ok()?;
    lock.lock().ok()?;
    Some(SpillDir { dir, _lock: lock })
}

/// How long a folder is left alone after it last changed. A run makes its
/// folder and then its lock, so for a moment a live run's folder looks like
/// an ended one's; another Magnolia starting in that moment mustn't take
/// it away. An ended run's folder is cleared by a later run instead.
const GRACE: std::time::Duration = std::time::Duration::from_secs(60);

/// Remove the folders of runs that have ended: their lock can be taken.
fn sweep(base: &Path) {
    sweep_older_than(base, GRACE);
}

fn sweep_older_than(base: &Path, grace: std::time::Duration) {
    let Ok(entries) = std::fs::read_dir(base) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        // Unknown age (or a clock set back) counts as new.
        let recent = std::fs::metadata(&path)
            .and_then(|m| m.modified())
            .map(|t| t.elapsed().map_or(true, |age| age < grace))
            .unwrap_or(true);
        if recent {
            continue;
        }
        let stale = match File::open(path.join(LOCK)) {
            Ok(f) => f.try_lock().is_ok(),
            // No lock file: a run that died before making one.
            Err(_) => true,
        };
        if stale {
            let _ = std::fs::remove_dir_all(&path);
        }
    }
}

/// A new, unused path in this run's folder, ending `.<ext>`; `None` if
/// there's no usable temporary folder (callers then keep data in memory).
fn new_path(ext: &str) -> Option<PathBuf> {
    let spill = SPILL.get_or_init(create).as_ref()?;
    let name = if ext.is_empty() {
        crate::util::new_guid()
    } else {
        format!("{}.{ext}", crate::util::new_guid())
    };
    Some(spill.dir.join(name))
}

/// A temporary file, deleted when the last handle to it goes — so a save
/// still copying it, or a player still reading it, keeps it until done.
#[derive(Debug)]
pub struct SpillFile {
    path: PathBuf,
}

impl SpillFile {
    /// A new, empty temporary file ending `.<ext>`.
    pub fn create(ext: &str) -> Option<SpillFile> {
        let file = SpillFile::reserve(ext)?;
        File::create(&file.path).ok()?;
        Some(file)
    }

    /// A temporary file's name, not yet created — for `std::fs::copy`,
    /// which can clone (instant on APFS) only to a path that doesn't exist.
    pub fn reserve(ext: &str) -> Option<SpillFile> {
        Some(SpillFile { path: new_path(ext)? })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for SpillFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sweeps_unlocked_folders_and_keeps_locked_ones() {
        let base = tempfile::tempdir().unwrap();
        let ended = base.path().join("ended");
        std::fs::create_dir_all(&ended).unwrap();
        File::create(ended.join(LOCK)).unwrap();
        std::fs::write(ended.join("x.mov"), b"x").unwrap();
        let running = base.path().join("running");
        std::fs::create_dir_all(&running).unwrap();
        let held = File::create(running.join(LOCK)).unwrap();
        held.lock().unwrap();
        sweep_older_than(base.path(), std::time::Duration::ZERO);
        assert!(!ended.exists());
        assert!(running.exists());
    }

    #[test]
    fn leaves_a_folder_just_made_by_a_run_still_starting() {
        let base = tempfile::tempdir().unwrap();
        // Made, but its lock not yet made (or not yet taken).
        let starting = base.path().join("starting");
        std::fs::create_dir_all(&starting).unwrap();
        sweep(base.path());
        assert!(starting.exists());
        File::create(starting.join(LOCK)).unwrap();
        sweep(base.path());
        assert!(starting.exists());
    }

    #[test]
    fn temporary_files_go_with_their_last_handle() {
        let a = std::sync::Arc::new(SpillFile::create("mov").unwrap());
        let b = SpillFile::create("mov").unwrap();
        assert_ne!(a.path(), b.path());
        assert!(a.path().extension().is_some_and(|e| e == "mov"));
        let path = a.path().to_path_buf();
        let reader = a.clone();
        drop(a);
        assert!(path.exists());
        drop(reader);
        assert!(!path.exists());
    }
}
