//! Read access to a .qdpx (zip) archive.
//!
//! Opening reads only the central directory; entries are decompressed on
//! demand, so pulling one PDF out of a 1 GB project costs that PDF, not the
//! whole archive (the TS build needed yauzl for this; JSZip loaded it all).

use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;
use zip::ZipArchive;

/// The most of one entry read whole into memory. A zip says how big each
/// entry is, but a damaged or crafted one can claim (or inflate to) far
/// more than it holds — a few kilobytes can unpack to gigabytes — so reads
/// stop here rather than exhaust memory. Media is never read whole (it's
/// streamed, see `binary_store`), so these only bound documents, images
/// and PDFs, and the project's own XML, text and JSON.
pub const MAX_READ: u64 = 2 << 30;
/// The same for text (the project's XML, documents' text, side tables),
/// which is parsed after it's read, taking several times its size again.
pub const MAX_TEXT_READ: u64 = 512 << 20;
/// The same for Magnolia's small marker entries (lock, project id, format).
pub const MAX_MARKER_READ: u64 = 1 << 20;

pub struct Archive {
    zip: ZipArchive<BufReader<File>>,
    /// File (non-directory) entry names, in archive order.
    names: Vec<String>,
}

impl Archive {
    pub fn open(path: impl AsRef<Path>) -> std::io::Result<Self> {
        let file = File::open(path)?;
        let zip = ZipArchive::new(BufReader::new(file)).map_err(std::io::Error::other)?;
        let names = (0..zip.len())
            .filter_map(|i| {
                zip.name_for_index(i)
                    .and_then(Result::ok)
                    .map(|n| n.into_owned())
            })
            .filter(|n| !n.ends_with('/'))
            .collect();
        Ok(Archive { zip, names })
    }

    pub fn names(&self) -> &[String] {
        &self.names
    }

    pub fn has(&self, name: &str) -> bool {
        self.names.iter().any(|n| n == name)
    }

    pub fn read(&mut self, name: &str) -> Option<Vec<u8>> {
        self.read_limited(name, MAX_READ)
    }

    /// An entry's bytes, or `None` if it's missing, unreadable, or more
    /// than `limit` bytes once unpacked.
    pub fn read_limited(&mut self, name: &str, limit: u64) -> Option<Vec<u8>> {
        if !self.has(name) {
            return None;
        }
        let f = self.zip.by_name(name).ok()?;
        if f.size() > limit {
            return None;
        }
        read_capped(f, limit).ok()
    }

    /// Where an uncompressed entry's bytes sit in the archive file (offset,
    /// length), so they can be read in place; `None` if it's compressed.
    pub fn stored_range(&mut self, name: &str) -> Option<(u64, u64)> {
        let f = self.zip.by_name(name).ok()?;
        if f.compression() != zip::CompressionMethod::Stored {
            return None;
        }
        Some((f.data_start()?, f.size()))
    }

    /// Read a text entry, tolerating Windows-1252 transcripts from other tools.
    pub fn read_text(&mut self, name: &str) -> Option<String> {
        self.read_limited(name, MAX_TEXT_READ)
            .map(|b| decode_maybe_windows1252(&b))
    }

    /// Strict UTF-8 read (lossy on invalid bytes), as JSZip's `'string'` did.
    pub fn read_utf8(&mut self, name: &str) -> Option<String> {
        self.read_limited(name, MAX_TEXT_READ)
            .map(|b| String::from_utf8_lossy(strip_bom(&b)).into_owned())
    }

    /// REFI-QDA doesn't fix the case of the sources folder: Magnolia writes
    /// `sources`, NVivo writes `Sources`. Detect whichever is present.
    pub fn sources_dir(&self) -> String {
        detect_sources_dir(&self.names)
    }

    /// The project's .qde: `project.qde` (older Magnolia) or any root-level
    /// `*.qde` (Atlas.ti / NVivo name it after the project).
    pub fn qde_name(&self) -> Option<String> {
        if self.has("project.qde") {
            return Some("project.qde".into());
        }
        self.names
            .iter()
            .find(|n| !n.contains('/') && n.to_lowercase().ends_with(".qde") && n.len() > 4)
            .cloned()
    }

    pub fn inner(&mut self) -> &mut ZipArchive<BufReader<File>> {
        &mut self.zip
    }
}

/// Everything `r` yields, or an error once it passes `limit` bytes — for a
/// zip entry, whose unpacked size can be far beyond what it claims.
pub fn read_capped(r: impl Read, limit: u64) -> std::io::Result<Vec<u8>> {
    let mut buf = Vec::new();
    r.take(limit + 1).read_to_end(&mut buf)?;
    if buf.len() as u64 > limit {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "the file unpacks to more than Magnolia can read",
        ));
    }
    Ok(buf)
}

fn strip_bom(b: &[u8]) -> &[u8] {
    b.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(b)
}

pub fn detect_sources_dir(names: &[String]) -> String {
    for n in names {
        if let Some(slash) = n.find('/')
            && slash > 0
            && n[..slash].eq_ignore_ascii_case("sources")
        {
            return n[..slash].to_string();
        }
    }
    "sources".into()
}

/// Decode as UTF-8 when valid, else as Windows-1252 (Atlas.ti writes
/// transcripts that way; a strict UTF-8 read turns curly quotes into U+FFFD).
/// A UTF-8 byte-order mark is dropped either way: decoded as Windows-1252
/// it would become three characters (`ï»¿`) and shift every position in
/// the text by three.
pub fn decode_maybe_windows1252(buf: &[u8]) -> String {
    let b = strip_bom(buf);
    match std::str::from_utf8(b) {
        Ok(s) => s.to_string(),
        Err(_) => encoding_rs::WINDOWS_1252
            .decode_without_bom_handling(b)
            .0
            .into_owned(),
    }
}

/// Read one entry by exact name without keeping the archive open.
pub fn read_entry(path: impl AsRef<Path>, name: &str) -> Option<Vec<u8>> {
    Archive::open(path).ok()?.read(name)
}

/// Extract one binary from any .qdpx by its in-archive filename under the
/// sources folder (used by Merge to pull bytes out of a comparison file).
pub fn read_archive_file(path: impl AsRef<Path>, internal_name: &str) -> Option<Vec<u8>> {
    let mut a = Archive::open(path).ok()?;
    let name = format!("{}/{internal_name}", a.sources_dir());
    a.read(&name)
}
