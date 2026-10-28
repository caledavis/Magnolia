//! Atomic .qdpx writing.
//!
//! The archive streams into a sibling temp file which is fsynced and then
//! renamed over the target. The rename is atomic on every platform, so a
//! crash or quit mid-save can never leave a half-written project behind —
//! worst case is a stray `.tmp` beside an intact original.

use std::fs::File;
use std::io::{BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

pub struct AtomicZip {
    zip: Option<ZipWriter<BufWriter<File>>>,
    tmp: PathBuf,
    target: PathBuf,
}

/// Already-compressed media gains nothing from deflate; store it as-is.
fn is_precompressed(name: &str) -> bool {
    let ext = crate::util::ext_of(name);
    matches!(
        ext.as_str(),
        "pdf"
            | "jpg"
            | "jpeg"
            | "png"
            | "gif"
            | "webp"
            | "mp3"
            | "m4a"
            | "aac"
            | "ogg"
            | "flac"
            | "mp4"
            | "mov"
            | "avi"
            | "audio"
            | "heic"
    )
}

fn options_for(name: &str) -> SimpleFileOptions {
    let method = if is_precompressed(name) {
        CompressionMethod::Stored
    } else {
        CompressionMethod::Deflated
    };
    SimpleFileOptions::default()
        .compression_method(method)
        .large_file(false)
}

impl AtomicZip {
    pub fn create(target: &Path) -> std::io::Result<Self> {
        let tmp = PathBuf::from(format!(
            "{}.{}.tmp",
            target.display(),
            crate::util::new_guid()
        ));
        let file = File::create(&tmp)?;
        Ok(AtomicZip {
            zip: Some(ZipWriter::new(BufWriter::new(file))),
            tmp,
            target: target.to_path_buf(),
        })
    }

    fn zip(&mut self) -> &mut ZipWriter<BufWriter<File>> {
        self.zip.as_mut().expect("zip already finished")
    }

    pub fn add(&mut self, name: &str, bytes: &[u8]) -> std::io::Result<()> {
        let opts = options_for(name).large_file(bytes.len() as u64 >= u32::MAX as u64);
        self.zip()
            .start_file(name, opts)
            .map_err(std::io::Error::other)?;
        self.zip().write_all(bytes)
    }

    /// Copy an entry from another archive without recompressing it — a
    /// multi-GB video carried forward costs one sequential copy.
    pub fn copy_from(
        &mut self,
        src: &mut ZipArchive<BufReader<File>>,
        src_name: &str,
        new_name: &str,
    ) -> std::io::Result<()> {
        let entry = src.by_name(src_name).map_err(std::io::Error::other)?;
        self.zip()
            .raw_copy_file_rename(entry, new_name)
            .map_err(std::io::Error::other)
    }

    /// Finish, fsync and atomically move into place.
    pub fn commit(mut self) -> std::io::Result<()> {
        let result = (|| {
            let writer = self
                .zip
                .take()
                .unwrap()
                .finish()
                .map_err(std::io::Error::other)?;
            let file = writer.into_inner().map_err(|e| e.into_error())?;
            file.sync_all()?;
            drop(file);
            std::fs::rename(&self.tmp, &self.target)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&self.tmp);
        }
        result
    }
}

impl Drop for AtomicZip {
    fn drop(&mut self) {
        // Abandoned before commit (error path): clean up the temp file.
        if self.zip.take().is_some() {
            let _ = std::fs::remove_file(&self.tmp);
        }
    }
}
