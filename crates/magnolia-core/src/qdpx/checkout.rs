//! Check-out lock state for a .qdpx, kept in Magnolia-only zip entries
//! (`magnolia-lock.json`, `magnolia-project-id.json`) — never in the .qde —
//! so it travels with the file and other tools simply ignore it.
//!
//! The lock is a fixed-size slot: the marker's JSON padded with spaces to
//! LOCK_SLOT_LEN bytes, stored uncompressed. Checking out or in rewrites
//! just those bytes (and the entry's CRC in its two headers) in place, so a
//! project with gigabytes of video changes by a few hundred bytes — and a
//! synced folder uploads only that block — rather than being copied whole.
//! A project without the slot yet (saved by an older Magnolia) is rewritten
//! once, the old way; every save writes the slot from then on. An empty
//! slot holds `{}`, which reads as no lock, in older Magnolias too.
//!
//! Checking out and in are check-and-set: the holder is checked before
//! writing (and, on the rewrite path, again just before the atomic rename),
//! so only a narrow race remains between separate Magnolia processes. That
//! rare race surfaces as a steal-back conflict at the next save (the
//! save-time staleness check is the real backstop), never as silent data
//! loss.

use super::archive::{Archive, read_entry};
use super::archive_write::AtomicZip;
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const LOCK_ENTRY: &str = "magnolia-lock.json";
pub const PROJECT_ID_ENTRY: &str = "magnolia-project-id.json";
pub const EDITOR_ENTRY: &str = "magnolia-editor.json";

/// Size of the lock slot, in bytes: room for any marker but a very long
/// user name (which falls back to rewriting the archive).
pub const LOCK_SLOT_LEN: usize = 512;

/// The lock entry for `marker` (none: unlocked), padded to the slot.
pub fn lock_entry_bytes(marker: Option<&CheckoutMarker>) -> Vec<u8> {
    let mut bytes = match marker {
        Some(m) => serde_json::to_vec(m).unwrap_or_else(|_| b"{}".to_vec()),
        None => b"{}".to_vec(),
    };
    if bytes.len() < LOCK_SLOT_LEN {
        bytes.resize(LOCK_SLOT_LEN, b' ');
    }
    bytes
}

/// Parse a lock entry: a marker, or None for an empty or unreadable one.
pub fn parse_lock_entry(bytes: &[u8]) -> Option<CheckoutMarker> {
    serde_json::from_slice(bytes).ok()
}

/// The project id from its entry, if there is one.
pub fn parse_project_id(bytes: &[u8]) -> Option<String> {
    serde_json::from_slice::<serde_json::Value>(bytes)
        .ok()?
        .get("projectId")?
        .as_str()
        .map(str::to_string)
}

/// Overwrite the lock slot in place with `bytes`, fixing the entry's CRC in
/// its local and central headers. False (nothing written) unless the slot
/// is exactly as expected: uncompressed, LOCK_SLOT_LEN long, no data
/// descriptor, no encryption.
fn write_lock_in_place(path: &Path, bytes: &[u8]) -> std::io::Result<bool> {
    use std::io::{Read, Seek, SeekFrom, Write};
    if bytes.len() != LOCK_SLOT_LEN {
        return Ok(false);
    }
    let (data_start, local, central) = {
        let mut a = Archive::open(path)?;
        if !a.has(LOCK_ENTRY) {
            return Ok(false);
        }
        let Ok(f) = a.inner().by_name(LOCK_ENTRY) else { return Ok(false) };
        if f.compression() != zip::CompressionMethod::Stored
            || f.size() != LOCK_SLOT_LEN as u64
            || f.compressed_size() != LOCK_SLOT_LEN as u64
            || f.encrypted()
        {
            return Ok(false);
        }
        let Some(data_start) = f.data_start() else { return Ok(false) };
        (data_start, f.header_start(), f.central_header_start())
    };
    let mut file = std::fs::OpenOptions::new().read(true).write(true).open(path)?;
    let u16_at = |file: &mut std::fs::File, at: u64| -> std::io::Result<u16> {
        let mut b = [0u8; 2];
        file.seek(SeekFrom::Start(at))?;
        file.read_exact(&mut b)?;
        Ok(u16::from_le_bytes(b))
    };
    let u32_at = |file: &mut std::fs::File, at: u64| -> std::io::Result<u32> {
        let mut b = [0u8; 4];
        file.seek(SeekFrom::Start(at))?;
        file.read_exact(&mut b)?;
        Ok(u32::from_le_bytes(b))
    };
    // Local header: signature, flags (bit 3 = sizes and CRC in a trailing
    // data descriptor), method. Central header: signature, method.
    if u32_at(&mut file, local)? != 0x0403_4b50
        || u16_at(&mut file, local + 6)? & 0x0009 != 0
        || u16_at(&mut file, local + 8)? != 0
        || u32_at(&mut file, central)? != 0x0201_4b50
        || u16_at(&mut file, central + 10)? != 0
    {
        return Ok(false);
    }
    let crc = crc32fast::hash(bytes).to_le_bytes();
    file.seek(SeekFrom::Start(data_start))?;
    file.write_all(bytes)?;
    file.seek(SeekFrom::Start(local + 14))?;
    file.write_all(&crc)?;
    file.seek(SeekFrom::Start(central + 16))?;
    file.write_all(&crc)?;
    file.sync_all()?;
    Ok(true)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutMarker {
    pub project_id: String,
    pub user_name: String,
    pub checked_out_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorInfo {
    pub last_edited_by: String,
    pub last_edited_at: String,
}

#[derive(Debug, Serialize)]
pub struct CheckoutWriteResult {
    pub ok: bool,
    pub marker: Option<CheckoutMarker>,
}

pub fn read_editor_info(path: &Path) -> Option<EditorInfo> {
    serde_json::from_slice(&read_entry(path, EDITOR_ENTRY)?).ok()
}

pub fn read_checkout_marker(path: &Path) -> Option<CheckoutMarker> {
    parse_lock_entry(&read_entry(path, LOCK_ENTRY)?)
}

pub enum CheckoutAction {
    CheckOut { steal: bool },
    CheckIn,
}

/// Set the lock: in place when the project has its slot and id, otherwise
/// by rewriting the archive with only the lock entries changed (every other
/// entry raw-copied), minting the project's stable id if it has none.
/// Fails if the file is missing.
pub fn write_checkout_marker(
    path: &Path,
    user_name: &str,
    action: CheckoutAction,
) -> std::io::Result<CheckoutWriteResult> {
    let mut src = Archive::open(path)?;

    let existing_id = src.read(PROJECT_ID_ENTRY).and_then(|b| parse_project_id(&b));
    let has_id = existing_id.is_some();
    let project_id = existing_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    let checking_in = matches!(action, CheckoutAction::CheckIn);
    let bypass = matches!(action, CheckoutAction::CheckOut { steal: true });

    let held_by_other = |m: Option<CheckoutMarker>| {
        m.filter(|m| !m.user_name.is_empty() && m.user_name != user_name)
    };

    if !bypass {
        let current = src.read(LOCK_ENTRY).and_then(|b| parse_lock_entry(&b));
        if let Some(other) = held_by_other(current) {
            return Ok(CheckoutWriteResult {
                ok: false,
                marker: Some(other),
            });
        }
    }

    let marker = (!checking_in).then(|| CheckoutMarker {
        project_id: project_id.clone(),
        user_name: user_name.to_string(),
        checked_out_at: crate::util::now_iso(),
    });

    // In place, when the project already has its id and slot.
    if has_id {
        drop(src);
        if !bypass && let Some(other) = held_by_other(read_checkout_marker(path)) {
            return Ok(CheckoutWriteResult { ok: false, marker: Some(other) });
        }
        if write_lock_in_place(path, &lock_entry_bytes(marker.as_ref()))? {
            return Ok(CheckoutWriteResult { ok: true, marker });
        }
        src = Archive::open(path)?;
    }

    let mut out = AtomicZip::create(path)?;
    let names: Vec<String> = src.names().to_vec();
    for name in names
        .iter()
        .filter(|n| *n != LOCK_ENTRY && *n != PROJECT_ID_ENTRY)
    {
        out.copy_from(src.inner(), name, name)?;
    }
    out.add(
        PROJECT_ID_ENTRY,
        serde_json::json!({ "projectId": project_id })
            .to_string()
            .as_bytes(),
    )?;
    out.add_stored(LOCK_ENTRY, &lock_entry_bytes(marker.as_ref()))?;

    // Late re-check: building the archive can take a while on a large
    // project — exactly the window another process could have taken the lock.
    if !bypass && let Some(other) = held_by_other(read_checkout_marker(path)) {
        return Ok(CheckoutWriteResult {
            ok: false,
            marker: Some(other),
        });
    }
    drop(src);
    out.commit()?;
    Ok(CheckoutWriteResult { ok: true, marker })
}
