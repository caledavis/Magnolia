//! Runtime source of truth for imported media bytes (PDF / image / audio /
//! video).
//!
//! The .qdpx is self-contained, so the renderer never sees a filesystem
//! path for media — it holds an opaque `magnolia-bin://` handle:
//!
//! - `archive/<name>`: a binary already saved in the open .qdpx, read
//!   straight out of `sources/<name>`.
//! - `overlay/<token>.<ext>`: a fresh import not yet saved, held in memory
//!   until the next save embeds it. After that the buffer is dropped and the
//!   handle resolves from the archive through the token → guid map the save
//!   recorded.

use crate::qdpx::archive::Archive;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

const HANDLE_PREFIX: &str = "magnolia-bin://";

#[derive(Default)]
struct Inner {
    active_project_path: Option<String>,
    overlay: HashMap<String, (Arc<Vec<u8>>, String)>,
    token_to_guid: HashMap<String, String>,
}

#[derive(Default)]
pub struct BinaryStore {
    inner: Mutex<Inner>,
}

pub enum HandleKind {
    Archive,
    Overlay,
}

pub struct ParsedHandle {
    pub kind: HandleKind,
    /// guid (archive) or token (overlay), extension stripped.
    pub id: String,
    /// The in-archive basename, e.g. `<guid>.<ext>`.
    pub name: String,
}

pub fn is_binary_handle(v: &str) -> bool {
    v.starts_with(HANDLE_PREFIX)
}

pub fn archive_handle(guid: &str, ext: &str) -> String {
    format!("{HANDLE_PREFIX}archive/{guid}.{ext}")
}

/// Handle for a binary under an arbitrary in-archive filename (other QDA
/// tools name binaries differently from the source guid).
pub fn archive_handle_for_file(file_name: &str) -> String {
    format!("{HANDLE_PREFIX}archive/{file_name}")
}

pub fn parse_handle(handle: &str) -> Option<ParsedHandle> {
    let rest = handle.strip_prefix(HANDLE_PREFIX)?;
    let (kind, name) = rest.split_once('/')?;
    let kind = match kind {
        "archive" => HandleKind::Archive,
        "overlay" => HandleKind::Overlay,
        _ => return None,
    };
    let id = match name.rfind('.') {
        Some(dot) if dot > 0 => &name[..dot],
        _ => name,
    };
    Some(ParsedHandle {
        kind,
        id: id.to_string(),
        name: name.to_string(),
    })
}

/// The in-archive filename of an archive handle (`None` for overlays).
pub fn archive_file_name_from_handle(handle: &str) -> Option<String> {
    parse_handle(handle)
        .filter(|p| matches!(p.kind, HandleKind::Archive))
        .map(|p| p.name)
}

impl BinaryStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record the open project. Only a switch to a DIFFERENT real project
    /// invalidates the overlay; `None` (closing / loading) never drops it,
    /// and re-asserting the same path keeps the token → guid mappings.
    pub fn set_active_project_path(&self, path: Option<&str>) {
        let mut s = self.inner.lock().unwrap();
        if let Some(p) = path.filter(|p| !p.is_empty()) {
            if s.active_project_path.as_deref() != Some(p) {
                s.overlay.clear();
                s.token_to_guid.clear();
            }
            s.active_project_path = Some(p.to_string());
        }
    }

    /// Set the active archive WITHOUT clearing the overlay (after a save, or
    /// when a binary read names its project). Never nulls the path.
    pub fn note_active_project_path(&self, path: Option<&str>) {
        if let Some(p) = path.filter(|p| !p.is_empty()) {
            self.inner.lock().unwrap().active_project_path = Some(p.to_string());
        }
    }

    pub fn active_project_path(&self) -> Option<String> {
        self.inner.lock().unwrap().active_project_path.clone()
    }

    /// Register freshly-imported bytes and return a handle for them.
    pub fn put_overlay(&self, bytes: Vec<u8>, ext: &str) -> String {
        let token = crate::util::new_guid();
        self.inner
            .lock()
            .unwrap()
            .overlay
            .insert(token.clone(), (Arc::new(bytes), ext.to_string()));
        format!("{HANDLE_PREFIX}overlay/{token}.{ext}")
    }

    pub fn overlay_bytes(&self, handle: &str) -> Option<Arc<Vec<u8>>> {
        let p = parse_handle(handle).filter(|p| matches!(p.kind, HandleKind::Overlay))?;
        self.inner
            .lock()
            .unwrap()
            .overlay
            .get(&p.id)
            .map(|(b, _)| b.clone())
    }

    /// After a save embedded an overlay binary as `sources/<guid>.<ext>`,
    /// free the buffer and remember token → guid.
    pub fn mark_persisted(&self, handle: &str, guid: &str) {
        if let Some(p) = parse_handle(handle).filter(|p| matches!(p.kind, HandleKind::Overlay)) {
            let mut s = self.inner.lock().unwrap();
            s.token_to_guid.insert(p.id.clone(), guid.to_string());
            s.overlay.remove(&p.id);
        }
    }

    /// Resolve a handle to bytes: overlays from memory (falling back to the
    /// archive once saved), archive handles from the open .qdpx.
    pub fn resolve(&self, handle: &str) -> Option<Arc<Vec<u8>>> {
        let p = parse_handle(handle)?;
        let (archive_path, name) = {
            let s = self.inner.lock().unwrap();
            match p.kind {
                HandleKind::Overlay => {
                    if let Some((b, _)) = s.overlay.get(&p.id) {
                        return Some(b.clone());
                    }
                    let guid = s.token_to_guid.get(&p.id)?;
                    let ext = &p.name[p.id.len() + 1..];
                    (s.active_project_path.clone()?, format!("{guid}.{ext}"))
                }
                HandleKind::Archive => (s.active_project_path.clone()?, p.name.clone()),
            }
        };
        read_from_archive(Path::new(&archive_path), &name).map(Arc::new)
    }

    /// Recover a legacy real-path reference from the open .qdpx by basename.
    pub fn read_archive_by_name(&self, name: &str) -> Option<Vec<u8>> {
        let path = self.active_project_path()?;
        read_from_archive(Path::new(&path), name)
    }
}

/// `sources/<name>` from an archive, or any non-text `sources/<guid>.*`.
fn read_from_archive(archive_path: &Path, name: &str) -> Option<Vec<u8>> {
    let mut a = Archive::open(archive_path).ok()?;
    let dir = a.sources_dir();
    let exact = format!("{dir}/{name}");
    if a.has(&exact) {
        return a.read(&exact);
    }
    let guid = match name.rfind('.') {
        Some(dot) => &name[..dot],
        None => name,
    };
    let prefix = format!("{dir}/{guid}.");
    let alt = a
        .names()
        .iter()
        .find(|n| n.starts_with(&prefix) && !n.to_lowercase().ends_with(".txt"))
        .cloned()?;
    a.read(&alt)
}
