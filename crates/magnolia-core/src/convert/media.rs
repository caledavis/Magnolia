//! Audio / video metadata read at import time. Best-effort: unknown values
//! fall back to defaults and the renderer's media element fills in duration
//! once it has loaded the file.

use lofty::file::AudioFile;
use lofty::probe::Probe;
use std::io::Cursor;
use std::path::Path;

pub struct AudioMetadata {
    pub duration: f64,
    pub channels: u32,
    pub sample_rate: u32,
}

pub fn audio_metadata(bytes: &[u8]) -> Option<AudioMetadata> {
    let file = Probe::new(Cursor::new(bytes))
        .guess_file_type()
        .ok()?
        .read()
        .ok()?;
    metadata_of(&file)
}

/// `audio_metadata` for a file on disk, read as needed rather than loaded.
pub fn audio_metadata_file(path: &Path) -> Option<AudioMetadata> {
    let file = Probe::open(path).ok()?.guess_file_type().ok()?.read().ok()?;
    metadata_of(&file)
}

fn metadata_of(file: &lofty::file::TaggedFile) -> Option<AudioMetadata> {
    let p = file.properties();
    Some(AudioMetadata {
        duration: p.duration().as_secs_f64(),
        channels: p.channels().map(u32::from).unwrap_or(1),
        sample_rate: p.sample_rate().unwrap_or(44100),
    })
}

/// Duration in seconds of an MP4 / MOV (ISO base media) file from its
/// `moov/mvhd` box; `None` for anything else (AVI etc.).
pub fn video_duration(bytes: &[u8]) -> Option<f64> {
    let moov = find_box(bytes, b"moov")?;
    let mvhd = find_box(moov, b"mvhd")?;
    let version = *mvhd.first()?;
    let (timescale, duration) = if version == 1 {
        (be_u32(mvhd, 20)? as f64, be_u64(mvhd, 24)? as f64)
    } else {
        (be_u32(mvhd, 12)? as f64, be_u32(mvhd, 16)? as f64)
    };
    (timescale > 0.0).then(|| duration / timescale)
}

/// `video_duration` for a file on disk: steps over the top-level boxes by
/// their headers and reads only the moov box.
pub fn video_duration_file(path: &Path) -> Option<f64> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let mut pos = 0u64;
    while pos + 8 <= len {
        f.seek(SeekFrom::Start(pos)).ok()?;
        let mut h = [0u8; 16];
        let n = f.read(&mut h).ok()?;
        let size32 = u32::from_be_bytes(h[0..4].try_into().ok()?) as u64;
        let size = match size32 {
            1 if n >= 16 => u64::from_be_bytes(h[8..16].try_into().ok()?),
            0 => len - pos,
            n => n,
        };
        if size < 8 {
            return None;
        }
        if &h[4..8] == b"moov" {
            // Don't trust a damaged size with a huge allocation.
            let size = size.min(len - pos).min(256 << 20);
            let mut moov = vec![0; size as usize];
            f.seek(SeekFrom::Start(pos)).ok()?;
            f.read_exact(&mut moov).ok()?;
            return video_duration(&moov);
        }
        pos += size;
    }
    None
}

fn be_u32(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

fn be_u64(b: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_be_bytes(b.get(at..at + 8)?.try_into().ok()?))
}

/// Payload of the first top-level box of `kind` within `data`.
fn find_box<'a>(data: &'a [u8], kind: &[u8; 4]) -> Option<&'a [u8]> {
    let mut i = 0usize;
    while i + 8 <= data.len() {
        let size32 = be_u32(data, i)? as usize;
        let (header, size) = match size32 {
            1 => (16, be_u64(data, i + 8)? as usize),
            0 => (8, data.len() - i),
            n => (8, n),
        };
        if size < header || i + size > data.len() {
            // Truncated box: still search inside if it's the one we want.
            if &data[i + 4..i + 8] == kind {
                return data.get(i + header..);
            }
            return None;
        }
        if &data[i + 4..i + 8] == kind {
            return Some(&data[i + header..i + size]);
        }
        i += size;
    }
    None
}
