//! Which version of Magnolia's project format a .qdpx was saved in, kept in
//! a Magnolia-only zip entry (`magnolia-format.json`) that other tools
//! ignore.
//!
//! A newer Magnolia may one day write a project in a way an older one would
//! misread, and saving would then lose what the older one didn't
//! understand. So every save records its format, and a Magnolia opens a
//! project from a newer format read-only: the writer refuses to save over
//! it, or to make a copy of it, and the app says why. Raise [`FORMAT`] only
//! when an older Magnolia would lose something by saving the new format.
//!
//! Magnolias from before this entry existed don't check it; a format change
//! has to wait until the Magnolias that do are in use.

use super::archive::{Archive, read_entry};
use serde_json::{Value, json};
use std::path::Path;

pub const FORMAT_ENTRY: &str = "magnolia-format.json";

/// The format this Magnolia writes (and reads in full).
pub const FORMAT: u64 = 1;

/// The entry's contents for a save by Magnolia `app_version`.
pub fn format_entry(app_version: &str) -> Value {
    json!({ "format": FORMAT, "savedBy": format!("Magnolia {app_version}") })
}

/// A project saved in a newer format than this Magnolia's: who saved it
/// ("Magnolia 3.0.0").
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewerFormat {
    pub saved_by: String,
}

fn newer(bytes: Option<Vec<u8>>) -> Option<NewerFormat> {
    let v: Value = serde_json::from_slice(&bytes?).ok()?;
    let format = v.get("format")?.as_u64()?;
    (format > FORMAT).then(|| NewerFormat {
        saved_by: v
            .get("savedBy")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("Magnolia")
            .to_string(),
    })
}

/// The file at `path`, if it's from a newer format.
pub fn newer_format_at(path: &Path) -> Option<NewerFormat> {
    newer(read_entry(path, FORMAT_ENTRY))
}

/// An open archive, if it's from a newer format.
pub fn newer_format_in(archive: &mut Archive) -> Option<NewerFormat> {
    newer(archive.read_limited(FORMAT_ENTRY, super::archive::MAX_MARKER_READ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_higher_format_is_newer() {
        let entry = |v: Value| Some(serde_json::to_vec(&v).unwrap());
        assert_eq!(newer(entry(format_entry("2.1.0"))), None);
        assert_eq!(newer(entry(json!({ "format": FORMAT + 1, "savedBy": "Magnolia 9.0.0" }))), Some(NewerFormat { saved_by: "Magnolia 9.0.0".into() }));
        assert_eq!(newer(entry(json!({ "format": FORMAT + 1 }))), Some(NewerFormat { saved_by: "Magnolia".into() }));
        // Unreadable or missing: an older Magnolia's file, not a newer one.
        assert_eq!(newer(Some(b"not json".to_vec())), None);
        assert_eq!(newer(None), None);
    }
}
