//! Odd and hostile project files: what a fault or a crafted file holds must
//! not crash Magnolia, read anything off the disk, or leave a project that
//! can't be saved or opened again.
mod common;
use common::*;
use magnolia_core::qdpx::archive::decode_maybe_windows1252;
use magnolia_core::qdpx::deserializer::deserialize_project;
use magnolia_core::qdpx::reader::read_qdpx;
use serde_json::json;

const G: &str = "AAAAAAAA-0000-0000-0000-000000000001";
const G2: &str = "AAAAAAAA-0000-0000-0000-000000000002";

fn project_xml(body: &str) -> String {
    format!(r#"<?xml version="1.0" encoding="utf-8"?><Project xmlns="urn:QDA-XML:project:1.0" name="T">{body}</Project>"#)
}

fn text_source_xml(guid: &str, name: &str) -> String {
    format!(r#"<TextSource guid="{guid}" name="{name}" plainTextPath="internal://{guid}.txt"/>"#)
}

// ── Malformed side tables ──

#[test]
fn malformed_side_tables_do_not_crash_the_reader() {
    let d = temp();
    let path = p(&d, "odd.qdpx");
    let xml = project_xml(&format!(
        r#"<Sources>{}</Sources><Sets><Set guid="{G2}" name="s"/></Sets>"#,
        text_source_xml(G, "x")
    ));
    let meta = json!({ "sourceMeta": [{ "guid": G, "sourceType": "video",
        "surveyCellSelections": [1, "x", { "startPosition": 1 }],
        "videoSelectionAnchors": [{ "startChar": 0 }] }] });
    let tags = json!({
        "categories": [{ "guid": "CCCCCCCC-0000-0000-0000-000000000001", "name": "c", "type": "text", "tags": [1, "x", null] }],
        "tagMeta": [{ "value": "v" }],
    });
    make_zip(&path, &[
        ("project.qde", xml.as_bytes()),
        (&format!("sources/{G}.txt"), b"hello"),
        ("magnolia-sources.json", meta.to_string().as_bytes()),
        ("magnolia-tags.json", tags.to_string().as_bytes()),
    ]);
    let project = read_qdpx(&path, None).unwrap();
    // A tag-meta row with no guid isn't any set's.
    assert!(project["sets"][0].get("value").is_none());
    // Only the object selection is kept, and no anchor without a guid moved it.
    let sels = project["sources"][0]["selections"].as_array().unwrap();
    assert_eq!(sels.len(), 1);
    assert_eq!(sels[0]["startPosition"], 1);
}

#[test]
fn deeply_nested_codes_are_refused_not_a_crash() {
    let depth = 50_000;
    let mut xml = String::from(r#"<Project name="T"><CodeBook><Codes>"#);
    for i in 0..depth {
        xml.push_str(&format!(r#"<Code guid="{i:08X}-0000-0000-0000-000000000000" name="c">"#));
    }
    for _ in 0..depth {
        xml.push_str("</Code>");
    }
    xml.push_str("</Codes></CodeBook></Project>");
    // A thread with a small stack, as the app's worker threads might have.
    let r = std::thread::Builder::new()
        .stack_size(1 << 20)
        .spawn(move || deserialize_project(&xml).map(|_| ()))
        .unwrap()
        .join()
        .unwrap();
    assert!(r.is_err());
}

#[test]
fn reasonably_nested_codes_still_read() {
    let depth = 40;
    let mut xml = String::from(r#"<Project name="T"><CodeBook><Codes>"#);
    for i in 0..depth {
        xml.push_str(&format!(r#"<Code guid="{i:08X}-0000-0000-0000-000000000000" name="c">"#));
    }
    for _ in 0..depth {
        xml.push_str("</Code>");
    }
    xml.push_str("</Codes></CodeBook></Project>");
    assert!(deserialize_project(&xml).is_ok());
}

#[test]
fn entity_declarations_are_refused() {
    let lol = r#"<?xml version="1.0"?><!DOCTYPE Project [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;">]><Project name="&b;"/>"#;
    assert!(deserialize_project(lol).is_err());
    // A plain DOCTYPE, with nothing declared, is harmless and still reads.
    let plain = r#"<?xml version="1.0"?><!DOCTYPE Project><Project name="Plain"/>"#;
    assert_eq!(deserialize_project(plain).unwrap()["name"], "Plain");
}

// ── Text encodings ──

#[test]
fn a_bom_before_windows_1252_text_is_not_decoded_as_text() {
    let mut b = vec![0xEF, 0xBB, 0xBF];
    b.extend_from_slice(b"caf\xE9");
    assert_eq!(decode_maybe_windows1252(&b), "caf\u{E9}");
}
