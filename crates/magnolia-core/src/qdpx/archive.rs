//! Read access to a .qdpx (zip) archive.
//!
//! Opening reads only the central directory; entries are decompressed on
//! demand, so pulling one PDF out of a 1 GB project costs that PDF, not the
//! whole archive (the TS build needed yauzl for this; JSZip loaded it all).

use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;
use zip::ZipArchive;

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
        if !self.has(name) {
            return None;
        }
        let mut f = self.zip.by_name(name).ok()?;
        let mut buf = Vec::with_capacity(f.size() as usize);
        f.read_to_end(&mut buf).ok()?;
        Some(buf)
    }

    /// Read a text entry, tolerating Windows-1252 transcripts from other tools.
    pub fn read_text(&mut self, name: &str) -> Option<String> {
        self.read(name).map(|b| decode_maybe_windows1252(&b))
    }

    /// Strict UTF-8 read (lossy on invalid bytes), as JSZip's `'string'` did.
    pub fn read_utf8(&mut self, name: &str) -> Option<String> {
        self.read(name)
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
pub fn decode_maybe_windows1252(buf: &[u8]) -> String {
    let b = strip_bom(buf);
    match std::str::from_utf8(b) {
        Ok(s) => s.to_string(),
        Err(_) => encoding_rs::WINDOWS_1252
            .decode_without_bom_handling(buf)
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
