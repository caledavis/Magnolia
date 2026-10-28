//! Shared helpers for the integration tests.
#![allow(dead_code)]

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

pub const APP_VERSION: &str = "0.0.0-test";

/// Validate a .qde against the tracked QDA-XML 1.0 Project.xsd with the
/// system `xmllint`. Returns `Ok(())` when valid, `Err(messages)` otherwise.
/// Skips (returns Ok) when xmllint isn't installed.
pub fn validate(xml: &str) -> Result<(), String> {
    let Ok(dir) = tempfile::tempdir() else {
        return Err("no temp dir".into());
    };
    let file = dir.path().join("project.qde");
    std::fs::write(&file, xml).unwrap();
    let xsd = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/Project.xsd");
    let out = match Command::new("xmllint")
        .arg("--noout")
        .arg("--schema")
        .arg(&xsd)
        .arg(&file)
        .output()
    {
        Ok(o) => o,
        Err(_) => {
            eprintln!("xmllint not found; skipping schema validation");
            return Ok(());
        }
    };
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).into_owned())
    }
}

/// Write a zip with the given entries (directories implied by paths).
pub fn make_zip(path: &Path, entries: &[(&str, &[u8])]) {
    let file = std::fs::File::create(path).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    for (name, bytes) in entries {
        zip.start_file(*name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap();
}

pub fn zip_entry(path: &Path, name: &str) -> Option<Vec<u8>> {
    magnolia_core::qdpx::archive::read_entry(path, name)
}

pub fn temp() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

pub fn p(dir: &tempfile::TempDir, name: &str) -> PathBuf {
    dir.path().join(name)
}

/// Every `name="value"` attribute of the first `<tag …>` in `xml`, as i64.
pub fn int_attr(xml: &str, tag: &str, name: &str) -> i64 {
    let start = xml.find(&format!("<{tag}")).expect("tag present");
    let end = start + xml[start..].find('>').unwrap();
    let el = &xml[start..end];
    let key = format!("{name}=\"");
    let s = el.find(&key).expect("attr present") + key.len();
    el[s..s + el[s..].find('"').unwrap()].parse().unwrap()
}
