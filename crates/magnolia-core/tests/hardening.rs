//! Odd and hostile project files: what a fault or a crafted file holds must
//! not crash Magnolia, read anything off the disk, or leave a project that
//! can't be saved or opened again.
mod common;
use common::*;
use magnolia_core::qdpx::archive::decode_maybe_windows1252;
use magnolia_core::qdpx::deserializer::deserialize_project;
use magnolia_core::qdpx::reader::read_qdpx;
use magnolia_core::qdpx::writer::{WriteError, WriteOptions, write_qdpx};
use serde_json::{Map, Value, json};
use std::path::Path;

const G: &str = "AAAAAAAA-0000-0000-0000-000000000001";
const G2: &str = "AAAAAAAA-0000-0000-0000-000000000002";

fn opts<'a>(carry: Option<&'a Path>) -> WriteOptions<'a> {
    WriteOptions { carry_forward_from: carry, app_version: APP_VERSION, ..Default::default() }
}

fn project_xml(body: &str) -> String {
    format!(r#"<?xml version="1.0" encoding="utf-8"?><Project xmlns="urn:QDA-XML:project:1.0" name="T">{body}</Project>"#)
}

fn text_source_xml(guid: &str, name: &str) -> String {
    format!(r#"<TextSource guid="{guid}" name="{name}" plainTextPath="internal://{guid}.txt"/>"#)
}

/// Open, then save to a new file and open that: the project as it comes back.
fn open_save_open(path: &Path) -> Value {
    let mut project = read_qdpx(path, None).unwrap();
    let contents = match project.as_object_mut().unwrap().remove("sourceContents") {
        Some(Value::Object(m)) => m,
        _ => Map::new(),
    };
    let saved = path.with_file_name("saved.qdpx");
    write_qdpx(&saved, &mut project, &contents, &opts(Some(path))).unwrap();
    read_qdpx(&saved, None).unwrap()
}

fn entry_names(path: &Path) -> Vec<String> {
    magnolia_core::qdpx::archive::Archive::open(path).unwrap().names().to_vec()
}

// ── Characters XML can't hold ──

#[test]
fn a_passage_named_with_a_form_feed_saves_and_opens_again() {
    let d = temp();
    let path = p(&d, "ff.qdpx");
    let mut project = json!({
        "name": "T", "origin": "test", "users": [], "codes": [], "sets": [], "notes": [],
        "description": "bell\u{7} here",
        "sources": [{ "guid": G, "name": "Doc\u{0}", "sourceType": "text",
            "selections": [{ "guid": G2, "name": "end of page\u{0C}next page", "startPosition": 0, "endPosition": 4, "codings": [] }] }],
    });
    let mut contents = Map::new();
    contents.insert(G.into(), "page\u{0C}two".into());
    write_qdpx(&path, &mut project, &contents, &opts(None)).unwrap();
    let back = read_qdpx(&path, None).unwrap();
    let sel = &back["sources"][0]["selections"][0];
    assert_eq!(sel["name"], "end of page next page");
    assert_eq!(back["sources"][0]["name"], "Doc");
    // The document's own text (a .txt, not XML) keeps it.
    assert_eq!(back["sourceContents"][G], "page\u{0C}two");
}

// ── Side tables naming files on disk ──

#[test]
fn a_side_table_cannot_make_save_copy_a_file_off_the_disk() {
    let d = temp();
    let secret = p(&d, "id_rsa");
    std::fs::write(&secret, b"PRIVATE KEY BYTES").unwrap();
    let path = p(&d, "hostile.qdpx");
    let xml = project_xml(&format!("<Sources>{}</Sources>", text_source_xml(G, "x")));
    let meta = json!({ "sourceMeta": [{ "guid": G, "sourceType": "image",
        "formatData": { "imageFilePath": secret.to_str().unwrap(), "imageExt": "png" } }] });
    make_zip(&path, &[
        ("project.qde", xml.as_bytes()),
        (&format!("sources/{G}.txt"), b"hi"),
        ("magnolia-sources.json", meta.to_string().as_bytes()),
    ]);
    let mut project = read_qdpx(&path, None).unwrap();
    let fd = &project["sources"][0]["formatData"];
    assert!(fd.get("imageFilePath").is_none(), "raw path kept: {fd}");
    let contents = match project.as_object_mut().unwrap().remove("sourceContents") {
        Some(Value::Object(m)) => m,
        _ => Map::new(),
    };
    let saved = p(&d, "saved.qdpx");
    let _ = write_qdpx(&saved, &mut project, &contents, &opts(Some(&path)));
    if saved.exists() {
        for n in entry_names(&saved) {
            let b = read_entry(&saved, &n);
            assert!(!b.windows(7).any(|w| w == b"PRIVATE"), "{n} holds the file's bytes");
        }
    }
}

fn read_entry(path: &Path, name: &str) -> Vec<u8> {
    zip_entry(path, name).unwrap_or_default()
}

#[test]
fn the_writer_does_not_read_a_raw_path_either() {
    let d = temp();
    let secret = p(&d, "secret.png");
    std::fs::write(&secret, b"PRIVATE IMAGE").unwrap();
    let path = p(&d, "raw.qdpx");
    let mut project = json!({
        "name": "T", "origin": "test", "users": [], "codes": [], "sets": [], "notes": [],
        "sources": [{ "guid": G, "name": "Pic", "sourceType": "image", "selections": [],
            "formatData": { "imageFilePath": secret.to_str().unwrap(), "imageExt": "png" } }],
    });
    let r = write_qdpx(&path, &mut project, &Map::new(), &opts(None));
    assert!(matches!(r, Err(WriteError::Guard(_))), "{:?}", r.err());
    assert!(!path.exists());
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

// ── GUIDs that can't name a file ──

#[test]
fn bad_and_clashing_guids_get_new_ones_and_save() {
    let d = temp();
    let path = p(&d, "guids.qdpx");
    let code = "20000000-0000-0000-0000-000000000001";
    let xml = project_xml(&format!(
        r#"<CodeBook><Codes><Code guid="{code}" name="C"/></Codes></CodeBook>
<Sources>
<TextSource guid="../../evil" name="Evil" plainTextPath="internal://evil.txt">
  <PlainTextSelection guid="../sel" startPosition="0" endPosition="2"><Coding guid="x/y"><CodeRef targetGUID="{code}"/></Coding></PlainTextSelection>
</TextSource>
<TextSource name="NoGuid1" plainTextPath="internal://one.txt"/>
<TextSource name="NoGuid2" plainTextPath="internal://two.txt"/>
<TextSource guid="{G}" name="Twin" plainTextPath="internal://twin.txt"/>
</Sources>
<Sets><Set guid="{G2}" name="S"><MemberSource targetGUID="../../evil"/></Set></Sets>
<Notes><Note guid="{G}" name="Memo"><PlainTextContent>note</PlainTextContent></Note></Notes>"#
    ));
    make_zip(&path, &[
        ("project.qde", xml.as_bytes()),
        ("sources/evil.txt", b"evil text"),
        ("sources/one.txt", b"one"),
        ("sources/two.txt", b"two"),
        ("sources/twin.txt", b"twin"),
    ]);
    let back = open_save_open(&path);
    let saved = path.with_file_name("saved.qdpx");
    for n in entry_names(&saved) {
        assert!(!n.contains(".."), "unsafe entry name {n}");
    }
    let sources = back["sources"].as_array().unwrap();
    assert_eq!(sources.len(), 4);
    let by_name = |n: &str| sources.iter().find(|s| s["name"] == n).unwrap();
    let evil = by_name("Evil");
    let evil_guid = evil["guid"].as_str().unwrap();
    assert!(evil_guid.chars().all(|c| c.is_ascii_hexdigit() || c == '-'), "{evil_guid}");
    assert_eq!(back["sourceContents"][evil_guid], "evil text");
    // The set still names it: its reference was mapped with it.
    assert_eq!(back["sets"][0]["memberSourceGuids"][0], evil_guid);
    let mut guids: Vec<&str> = sources.iter().map(|s| s["guid"].as_str().unwrap()).collect();
    guids.sort();
    guids.dedup();
    assert_eq!(guids.len(), 4);
    assert_eq!(back["sourceContents"][by_name("NoGuid2")["guid"].as_str().unwrap()], "two");
    assert_eq!(back["sourceContents"][G], "twin");
    let memo = &back["memos"][0];
    assert_ne!(memo["guid"], G);
    assert_eq!(memo["content"], "note");
}

// ── Text encodings ──

#[test]
fn a_bom_before_windows_1252_text_is_not_decoded_as_text() {
    let mut b = vec![0xEF, 0xBB, 0xBF];
    b.extend_from_slice(b"caf\xE9");
    assert_eq!(decode_maybe_windows1252(&b), "caf\u{E9}");
}

// ── Text missing from what the renderer sent ──

#[test]
fn a_text_missing_from_the_save_is_carried_forward() {
    let d = temp();
    let path = p(&d, "carry.qdpx");
    let xml = project_xml(&format!("<Sources>{}{}</Sources>", text_source_xml(G, "a"), text_source_xml(G2, "b")));
    make_zip(&path, &[
        ("project.qde", xml.as_bytes()),
        (&format!("sources/{G}.txt"), b"first"),
        (&format!("sources/{G2}.txt"), b"second"),
    ]);
    let mut project = read_qdpx(&path, None).unwrap();
    project.as_object_mut().unwrap().remove("sourceContents");
    let mut contents = Map::new();
    contents.insert(G.into(), "first, edited".into());
    write_qdpx(&path, &mut project, &contents, &opts(None)).unwrap();
    assert_eq!(read_entry(&path, &format!("sources/{G}.txt")), b"first, edited");
    assert_eq!(read_entry(&path, &format!("sources/{G2}.txt")), b"second");
}

// ── File permissions ──

#[cfg(unix)]
#[test]
fn saving_keeps_the_files_permissions() {
    use std::os::unix::fs::PermissionsExt;
    let d = temp();
    let path = p(&d, "shared.qdpx");
    let mut project = json!({ "name": "T", "origin": "test", "users": [], "codes": [], "sources": [], "sets": [], "notes": [] });
    write_qdpx(&path, &mut project, &Map::new(), &opts(None)).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640)).unwrap();
    write_qdpx(&path, &mut project, &Map::new(), &opts(None)).unwrap();
    assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o640);
}
