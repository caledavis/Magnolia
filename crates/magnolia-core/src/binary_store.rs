//! Runtime source of truth for imported media bytes (PDF / image / audio /
//! video).
//!
//! The .qdpx is self-contained, so the renderer never sees a filesystem
//! path for media — it holds an opaque `magnolia-bin://` handle:
//!
//! - `archive/<name>`: a binary already saved in the open .qdpx, read
//!   straight out of `sources/<name>`.
//! - `overlay/<token>.<ext>`: a fresh import not yet saved, held until the
//!   next save embeds it — in memory if it's small, otherwise in a temporary
//!   file (`crate::spill`), so a long recording doesn't take its size in
//!   memory. After the save it's dropped and the handle resolves from the
//!   archive through the token → guid map the save recorded.

use crate::qdpx::archive::Archive;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

const HANDLE_PREFIX: &str = "magnolia-bin://";

/// Imports at least this big are kept in a temporary file, not in memory.
const SPILL_BYTES: usize = 16 << 20;

#[derive(Default)]
struct Inner {
    active_project_path: Option<String>,
    /// token → (bytes, extension).
    overlay: HashMap<String, (MediaSource, String)>,
    token_to_guid: HashMap<String, String>,
    /// The last compressed archive binary `locate` had to inflate, so the
    /// range reads that follow (a player seeking) don't inflate it again.
    inflated: Option<(String, MediaSource)>,
}

impl Inner {
    /// Temporary files go with their last handle (`SpillFile`).
    fn clear_overlay(&mut self) {
        self.overlay.clear();
        self.token_to_guid.clear();
        self.inflated = None;
    }
}

/// Where a binary's bytes are, for reading part of it (media streaming).
#[derive(Clone)]
pub enum MediaSource {
    Memory(Arc<Vec<u8>>),
    /// `len` bytes at `offset` in the file at `path`: an uncompressed
    /// archive entry (media is stored, not deflated) or a plain file.
    File { path: std::path::PathBuf, offset: u64, len: u64 },
    /// A temporary file of ours (`crate::spill`), deleted once the last
    /// clone of this goes.
    Spilled { file: Arc<crate::spill::SpillFile>, len: u64 },
}

impl MediaSource {
    pub fn len(&self) -> u64 {
        match self {
            MediaSource::Memory(b) => b.len() as u64,
            MediaSource::File { len, .. } | MediaSource::Spilled { len, .. } => *len,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// All of it, in memory.
    pub fn bytes(&self) -> std::io::Result<Arc<Vec<u8>>> {
        match self {
            MediaSource::Memory(b) => Ok(b.clone()),
            _ => self.read(0, self.len()).map(Arc::new),
        }
    }

    /// Bytes `start..end` (clamped to the binary's length).
    pub fn read(&self, start: u64, end: u64) -> std::io::Result<Vec<u8>> {
        let end = end.min(self.len());
        let start = start.min(end);
        let Some((path, offset)) = self.file() else {
            let MediaSource::Memory(b) = self else { unreachable!() };
            return Ok(b[start as usize..end as usize].to_vec());
        };
        use std::io::{Read, Seek, SeekFrom};
        let mut f = std::fs::File::open(path)?;
        f.seek(SeekFrom::Start(offset + start))?;
        let mut buf = vec![0; (end - start) as usize];
        f.read_exact(&mut buf)?;
        Ok(buf)
    }

    /// The file the bytes are in and where in it they start, unless they're
    /// in memory.
    pub fn file(&self) -> Option<(&Path, u64)> {
        match self {
            MediaSource::Memory(_) => None,
            MediaSource::File { path, offset, .. } => Some((path, *offset)),
            MediaSource::Spilled { file, .. } => Some((file.path(), 0)),
        }
    }
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
                s.clear_overlay();
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

    fn register(&self, source: MediaSource, ext: &str) -> String {
        let token = crate::util::new_guid();
        self.inner
            .lock()
            .unwrap()
            .overlay
            .insert(token.clone(), (source, ext.to_string()));
        format!("{HANDLE_PREFIX}overlay/{token}.{ext}")
    }

    /// Register freshly-imported bytes and return a handle for them. Large
    /// ones go to a temporary file, freeing the memory.
    pub fn put_overlay(&self, bytes: Vec<u8>, ext: &str) -> String {
        let source = if bytes.len() >= SPILL_BYTES {
            spill_bytes(&bytes, ext).unwrap_or_else(|| MediaSource::Memory(Arc::new(bytes)))
        } else {
            MediaSource::Memory(Arc::new(bytes))
        };
        self.register(source, ext)
    }

    /// Register a file being imported, copied to a temporary file so the
    /// original can move or go before the save embeds it — without reading
    /// it into memory. (On APFS the copy is a clone: instant, and no extra
    /// space until either changes. That needs a path that doesn't exist
    /// yet, hence `reserve`.)
    pub fn put_overlay_file(&self, path: &Path, ext: &str) -> std::io::Result<String> {
        let len = std::fs::metadata(path)?.len();
        let spill = (len >= SPILL_BYTES as u64)
            .then(|| crate::spill::SpillFile::reserve(ext))
            .flatten();
        let source = match spill {
            Some(tmp) => {
                std::fs::copy(path, tmp.path())?;
                MediaSource::Spilled { file: Arc::new(tmp), len }
            }
            None => MediaSource::Memory(Arc::new(std::fs::read(path)?)),
        };
        Ok(self.register(source, ext))
    }

    /// An unsaved import's bytes, wherever they're kept.
    pub fn overlay_source(&self, handle: &str) -> Option<MediaSource> {
        let p = parse_handle(handle).filter(|p| matches!(p.kind, HandleKind::Overlay))?;
        self.inner
            .lock()
            .unwrap()
            .overlay
            .get(&p.id)
            .map(|(source, _)| source.clone())
    }

    /// An unsaved import's bytes, in memory (read from its temporary file
    /// if that's where it is).
    pub fn overlay_bytes(&self, handle: &str) -> Option<Arc<Vec<u8>>> {
        self.overlay_source(handle)?.bytes().ok()
    }

    /// After a save embedded an overlay binary as `sources/<guid>.<ext>`,
    /// free it and remember token → guid.
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
                    if let Some((source, _)) = s.overlay.get(&p.id) {
                        let source = source.clone();
                        drop(s);
                        return source.bytes().ok();
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

    /// Where `handle`'s bytes can be read from without loading them all:
    /// in memory for a fresh import, in place for an uncompressed archive
    /// entry. A compressed entry is inflated once and kept (just the last
    /// one). Anything that isn't a handle is a legacy real path: read in
    /// place if `read_real_path` (the caller vouches for that file),
    /// otherwise recovered from the archive by its basename.
    pub fn locate(&self, handle: &str, read_real_path: bool) -> Option<MediaSource> {
        let (archive_path, name) = match parse_handle(handle) {
            Some(p) => {
                let s = self.inner.lock().unwrap();
                match p.kind {
                    HandleKind::Overlay => {
                        if let Some((source, _)) = s.overlay.get(&p.id) {
                            return Some(source.clone());
                        }
                        let guid = s.token_to_guid.get(&p.id)?;
                        let ext = &p.name[p.id.len() + 1..];
                        (s.active_project_path.clone()?, format!("{guid}.{ext}"))
                    }
                    HandleKind::Archive => (s.active_project_path.clone()?, p.name.clone()),
                }
            }
            None => {
                if let Some(m) = std::fs::metadata(handle).ok().filter(|m| read_real_path && m.is_file()) {
                    return Some(MediaSource::File { path: handle.into(), offset: 0, len: m.len() });
                }
                let name = Path::new(handle).file_name()?.to_string_lossy().into_owned();
                (self.active_project_path()?, name)
            }
        };
        let key = format!("{archive_path}\0{name}");
        if let Some((k, source)) = &self.inner.lock().unwrap().inflated
            && *k == key
        {
            return Some(source.clone());
        }
        let mut a = Archive::open(&archive_path).ok()?;
        let entry = find_source_entry(&a, &name)?;
        if let Some((offset, len)) = a.stored_range(&entry) {
            return Some(MediaSource::File { path: archive_path.into(), offset, len });
        }
        // Compressed (other tools write media that way): unpack it to a
        // temporary file to stream from, or into memory if that fails.
        let ext = name.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
        let source = inflate_to_spill(&mut a, &entry, ext)
            .or_else(|| a.read(&entry).map(|b| MediaSource::Memory(Arc::new(b))))?;
        self.inner.lock().unwrap().inflated = Some((key, source.clone()));
        Some(source)
    }

    /// Recover a legacy real-path reference from the open .qdpx by basename.
    pub fn read_archive_by_name(&self, name: &str) -> Option<Vec<u8>> {
        let path = self.active_project_path()?;
        read_from_archive(Path::new(&path), name)
    }
}

/// Write `bytes` to a new temporary file.
fn spill_bytes(bytes: &[u8], ext: &str) -> Option<MediaSource> {
    let file = crate::spill::SpillFile::create(ext)?;
    std::fs::write(file.path(), bytes).ok()?;
    Some(MediaSource::Spilled { file: Arc::new(file), len: bytes.len() as u64 })
}

/// Unpack an archive entry to a new temporary file, a buffer at a time.
fn inflate_to_spill(a: &mut Archive, entry: &str, ext: &str) -> Option<MediaSource> {
    let file = crate::spill::SpillFile::create(ext)?;
    let len = (|| -> std::io::Result<u64> {
        let mut out = std::io::BufWriter::new(std::fs::File::create(file.path())?);
        let mut f = a.inner().by_name(entry).map_err(std::io::Error::other)?;
        let len = std::io::copy(&mut f, &mut out)?;
        std::io::Write::flush(&mut out)?;
        Ok(len)
    })()
    .ok()?;
    Some(MediaSource::Spilled { file: Arc::new(file), len })
}

/// `sources/<name>` from an archive, or any non-text `sources/<guid>.*`.
fn read_from_archive(archive_path: &Path, name: &str) -> Option<Vec<u8>> {
    let mut a = Archive::open(archive_path).ok()?;
    let entry = find_source_entry(&a, name)?;
    a.read(&entry)
}

/// The entry `read_from_archive` reads for `name`.
fn find_source_entry(a: &Archive, name: &str) -> Option<String> {
    let dir = a.sources_dir();
    let exact = format!("{dir}/{name}");
    if a.has(&exact) {
        return Some(exact);
    }
    let guid = match name.rfind('.') {
        Some(dot) => &name[..dot],
        None => name,
    };
    let prefix = format!("{dir}/{guid}.");
    a.names()
        .iter()
        .find(|n| n.starts_with(&prefix) && !n.to_lowercase().ends_with(".txt"))
        .cloned()
}
