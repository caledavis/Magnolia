//! Audio / video metadata read at import time. Best-effort: unknown values
//! fall back to defaults and the renderer's media element fills in duration
//! once it has loaded the file.

use lofty::file::AudioFile;
use lofty::probe::Probe;
use std::io::Cursor;

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
