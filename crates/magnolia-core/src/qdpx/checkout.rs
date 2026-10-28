//! Check-out lock state for a .qdpx, kept in Magnolia-only zip entries
//! (`magnolia-lock.json`, `magnolia-project-id.json`) — never in the .qde —
//! so it travels with the file and other tools simply ignore it.
//!
//! Checking out and in are check-and-set: the holder is checked against the
//! archive being rewritten and re-checked just before the atomic rename, so
//! only a narrow race remains between separate Magnolia processes. That rare
//! race surfaces as a steal-back conflict at the next save (the save-time
//! staleness check is the real backstop), never as silent data loss.

use super::archive::{Archive, read_entry};
use super::archive_write::AtomicZip;
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const LOCK_ENTRY: &str = "magnolia-lock.json";
pub const PROJECT_ID_ENTRY: &str = "magnolia-project-id.json";
pub const EDITOR_ENTRY: &str = "magnolia-editor.json";

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
    serde_json::from_slice(&read_entry(path, LOCK_ENTRY)?).ok()
}

pub enum CheckoutAction {
    CheckOut { steal: bool },
    CheckIn,
}

/// Patch only the lock entries; every other entry is raw-copied unchanged.
/// Mints the project's stable id on first use. Fails if the file is missing.
pub fn write_checkout_marker(
    path: &Path,
    user_name: &str,
    action: CheckoutAction,
) -> std::io::Result<CheckoutWriteResult> {
    let mut src = Archive::open(path)?;

    let project_id = src
        .read(PROJECT_ID_ENTRY)
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .and_then(|v| {
            v.get("projectId")
                .and_then(|p| p.as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    let checking_in = matches!(action, CheckoutAction::CheckIn);
    let bypass = matches!(action, CheckoutAction::CheckOut { steal: true });

    let held_by_other = |m: Option<CheckoutMarker>| {
        m.filter(|m| !m.user_name.is_empty() && m.user_name != user_name)
    };

    if !bypass {
        let current = src
            .read(LOCK_ENTRY)
            .and_then(|b| serde_json::from_slice::<CheckoutMarker>(&b).ok());
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
    if let Some(m) = &marker {
        out.add(LOCK_ENTRY, serde_json::to_string(m).unwrap().as_bytes())?;
    }

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
