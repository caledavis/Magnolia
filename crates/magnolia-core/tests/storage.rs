//! Archive reading, check-out locks, the writer's safety behaviour and the
//! binary store (ported from zip-entry, text-encoding, checkout-marker,
//! writer-lock-carry-forward, writer-overlay-concurrent-save, binary-store,
//! merge-binary-import, nvivo-sources-case, notes-roundtrip and codebook
//! tests).

mod common;
use common::*;
use magnolia_core::binary_store::{
    BinaryStore, archive_file_name_from_handle, archive_handle, archive_handle_for_file,
};
use magnolia_core::qdpx::archive::{
    Archive, decode_maybe_windows1252, read_archive_file, read_entry,
};
use magnolia_core::qdpx::checkout::{
    CheckoutAction, read_checkout_marker, read_editor_info, write_checkout_marker,
};
use magnolia_core::qdpx::codebook::{deserialize_codebook, serialize_codebook};
use magnolia_core::qdpx::reader::read_qdpx;
use magnolia_core::qdpx::writer::{WriteError, WriteOptions, write_qdpx};
use serde_json::{Map, Value, json};
use std::path::Path;

const QDE: &[u8] = b"<Project name=\"Test\"></Project>";

fn opts<'a>(store: Option<&'a BinaryStore>, editor: &'a str) -> WriteOptions<'a> {
    WriteOptions {
        store,
        app_version: APP_VERSION,
        editor_name: editor,
        ..Default::default()
    }
}

fn empty_project() -> Value {
    json!({ "name": "Test", "origin": "test", "users": [], "codes": [], "sources": [], "sets": [], "notes": [] })
}

fn json_entry(path: &Path, name: &str) -> Option<Value> {
    serde_json::from_slice(&read_entry(path, name)?).ok()
}

// ── Archive reading ──

#[test]
fn reads_one_entry_and_reports_missing() {
    let d = temp();
    let path = p(&d, "a.qdpx");
    let pdf = vec![0x25u8, 0x50, 0x44, 0x46, 1, 2, 3];
    make_zip(
        &path,
        &[
            ("project.qde", QDE),
            ("sources/AAA.pdf", &pdf),
            ("sources/BBB.txt", b"t"),
            ("magnolia-lock.json", b"{\"userName\":\"A\"}"),
        ],
    );
    assert_eq!(read_entry(&path, "sources/AAA.pdf").unwrap(), pdf);
    assert_eq!(
        read_entry(&path, "magnolia-lock.json").unwrap(),
        b"{\"userName\":\"A\"}"
    );
    assert!(read_entry(&path, "sources/NOPE.pdf").is_none());
    let a = Archive::open(&path).unwrap();
    assert!(a.names().iter().all(|n| !n.ends_with('/')));
    assert!(
        ["project.qde", "sources/AAA.pdf", "sources/BBB.txt"]
            .iter()
            .all(|n| a.has(n))
    );
}

#[test]
fn rejects_a_file_that_is_not_a_zip() {
    let d = temp();
    let bad = p(&d, "bad.qdpx");
    std::fs::write(&bad, b"not a zip").unwrap();
    assert!(Archive::open(&bad).is_err());
}

#[test]
fn honours_nvivo_sources_folder_casing() {
    let d = temp();
    let (nvivo, lower) = (p(&d, "n.qdpx"), p(&d, "l.qdpx"));
    make_zip(&nvivo, &[("Sources/AAA.pdf", b"pdf")]);
    make_zip(&lower, &[("sources/AAA.pdf", b"pdf")]);
    assert_eq!(read_archive_file(&nvivo, "AAA.pdf").unwrap(), b"pdf");
    assert_eq!(read_archive_file(&lower, "AAA.pdf").unwrap(), b"pdf");
    assert!(read_archive_file(&lower, "ZZZ.pdf").is_none());
}

#[test]
fn reader_loads_text_from_either_sources_casing() {
    let xml = br#"<?xml version="1.0" encoding="utf-8"?>
<Project origin="NVivo 14" xmlns="urn:QDA-XML:project:1.0" name="NVivo Export">
 <Sources><TextSource plainTextPath="internal://ABC123.txt" guid="ABC123" name="Interview 1"/></Sources>
</Project>"#;
    let text = "Interviewer: Tell me about your experience.\nParticipant: It was great.";
    for folder in ["Sources", "sources"] {
        let d = temp();
        let path = p(&d, "t.qdpx");
        make_zip(
            &path,
            &[
                ("project.qde", xml),
                (&format!("{folder}/ABC123.txt"), text.as_bytes()),
            ],
        );
        let r = read_qdpx(&path, None).unwrap();
        assert_eq!(r["sourceContents"]["ABC123"], text, "folder {folder}");
    }
}

#[test]
fn decodes_utf8_and_windows_1252() {
    assert_eq!(
        decode_maybe_windows1252("Héllo — “world” 😀".as_bytes()),
        "Héllo — “world” 😀"
    );
    let d = decode_maybe_windows1252(&[0x48, 0x65, 0x92, 0x73]);
    assert_eq!(d, "He’s");
    assert!(!d.contains('\u{FFFD}'));
    assert_eq!(
        decode_maybe_windows1252(&[0x93, 0x71, 0x94, 0x20, 0x85, 0x20, 0x97]),
        "“q” … —"
    );
    assert_eq!(
        decode_maybe_windows1252(b"plain text 123"),
        "plain text 123"
    );
}

// ── Check-out locks ──

fn qdpx_with_source(d: &tempfile::TempDir, name: &str) -> std::path::PathBuf {
    let path = p(d, name);
    make_zip(
        &path,
        &[("project.qde", QDE), ("sources/x.txt", b"hello world")],
    );
    path
}

#[test]
fn marker_reads_are_tolerant() {
    let d = temp();
    assert!(read_checkout_marker(&qdpx_with_source(&d, "none.qdpx")).is_none());
    assert!(read_checkout_marker(&p(&d, "missing.qdpx")).is_none());
    let corrupt = p(&d, "corrupt.qdpx");
    make_zip(
        &corrupt,
        &[
            ("project.qde", QDE),
            ("magnolia-lock.json", b"{not valid json"),
        ],
    );
    assert!(read_checkout_marker(&corrupt).is_none());
}

#[test]
fn checkout_mints_and_reuses_project_id() {
    let d = temp();
    let path = qdpx_with_source(&d, "mint.qdpx");
    let first =
        write_checkout_marker(&path, "Alice", CheckoutAction::CheckOut { steal: false }).unwrap();
    assert!(first.ok);
    let m1 = first.marker.unwrap();
    assert_eq!(m1.user_name, "Alice");
    assert!(!m1.project_id.is_empty());
    let second =
        write_checkout_marker(&path, "Alice", CheckoutAction::CheckOut { steal: false }).unwrap();
    assert!(second.ok);
    assert_eq!(second.marker.unwrap().project_id, m1.project_id);
}

#[test]
fn checkout_by_someone_else_is_refused() {
    let d = temp();
    let path = qdpx_with_source(&d, "conflict.qdpx");
    let first =
        write_checkout_marker(&path, "Alice", CheckoutAction::CheckOut { steal: false }).unwrap();
    let second =
        write_checkout_marker(&path, "Bob", CheckoutAction::CheckOut { steal: false }).unwrap();
    assert!(!second.ok);
    assert_eq!(second.marker.unwrap().user_name, "Alice");
    assert_eq!(read_checkout_marker(&path).unwrap(), first.marker.unwrap());
}

#[test]
fn steal_writes_through() {
    let d = temp();
    let path = qdpx_with_source(&d, "steal.qdpx");
    write_checkout_marker(&path, "Alice", CheckoutAction::CheckOut { steal: false }).unwrap();
    let stolen =
        write_checkout_marker(&path, "Bob", CheckoutAction::CheckOut { steal: true }).unwrap();
    assert!(stolen.ok);
    assert_eq!(read_checkout_marker(&path).unwrap().user_name, "Bob");
}

#[test]
fn check_in_removes_lock_but_keeps_project_id() {
    let d = temp();
    let path = qdpx_with_source(&d, "checkin.qdpx");
    let m = write_checkout_marker(&path, "Alice", CheckoutAction::CheckOut { steal: false })
        .unwrap()
        .marker
        .unwrap();
    let r = write_checkout_marker(&path, "Alice", CheckoutAction::CheckIn).unwrap();
    assert!(r.ok && r.marker.is_none());
    assert!(read_checkout_marker(&path).is_none());
    assert_eq!(
        json_entry(&path, "magnolia-project-id.json").unwrap()["projectId"],
        m.project_id.as_str()
    );
}

#[test]
fn check_in_of_someone_elses_lock_is_refused() {
    let d = temp();
    let path = qdpx_with_source(&d, "checkin-conflict.qdpx");
    write_checkout_marker(&path, "Alice", CheckoutAction::CheckOut { steal: false }).unwrap();
    let r = write_checkout_marker(&path, "Bob", CheckoutAction::CheckIn).unwrap();
    assert!(!r.ok);
    assert_eq!(r.marker.unwrap().user_name, "Alice");
    assert_eq!(read_checkout_marker(&path).unwrap().user_name, "Alice");
}

#[test]
fn checkout_leaves_other_entries_identical() {
    let d = temp();
    let path = qdpx_with_source(&d, "untouched.qdpx");
    write_checkout_marker(&path, "Alice", CheckoutAction::CheckOut { steal: false }).unwrap();
    assert_eq!(read_entry(&path, "project.qde").unwrap(), QDE);
    assert_eq!(read_entry(&path, "sources/x.txt").unwrap(), b"hello world");
}

#[test]
fn editor_info_reads_are_tolerant() {
    let d = temp();
    assert!(read_editor_info(&qdpx_with_source(&d, "no-editor.qdpx")).is_none());
    assert!(read_editor_info(&p(&d, "missing.qdpx")).is_none());
    let corrupt = p(&d, "c.qdpx");
    make_zip(
        &corrupt,
        &[
            ("project.qde", QDE),
            ("magnolia-editor.json", b"{not valid json"),
        ],
    );
    assert!(read_editor_info(&corrupt).is_none());
    let good = p(&d, "g.qdpx");
    make_zip(
        &good,
        &[
            ("project.qde", QDE),
            (
                "magnolia-editor.json",
                br#"{"lastEditedBy":"Alice","lastEditedAt":"2024-01-01T00:00:00.000Z"}"#,
            ),
        ],
    );
    let info = read_editor_info(&good).unwrap();
    assert_eq!(
        (info.last_edited_by.as_str(), info.last_edited_at.as_str()),
        ("Alice", "2024-01-01T00:00:00.000Z")
    );
}

// ── Writer: lock carry-forward and editor stamp ──

#[test]
fn save_preserves_lock_and_project_id() {
    let d = temp();
    let path = p(&d, "checked-out.qdpx");
    let lock = json!({ "projectId": "fixed-id", "userName": "Alice", "checkedOutAt": "2024-01-01T00:00:00.000Z" });
    make_zip(
        &path,
        &[
            ("project.qde", QDE),
            ("magnolia-project-id.json", br#"{"projectId":"fixed-id"}"#),
            ("magnolia-lock.json", lock.to_string().as_bytes()),
        ],
    );
    write_qdpx(&path, &mut empty_project(), &Map::new(), &opts(None, "")).unwrap();
    assert_eq!(json_entry(&path, "magnolia-lock.json").unwrap(), lock);
    assert_eq!(
        json_entry(&path, "magnolia-project-id.json").unwrap(),
        json!({ "projectId": "fixed-id" })
    );
}

#[test]
fn save_adds_no_lock_to_a_never_checked_out_project() {
    let d = temp();
    let path = p(&d, "never.qdpx");
    make_zip(&path, &[("project.qde", QDE)]);
    write_qdpx(&path, &mut empty_project(), &Map::new(), &opts(None, "")).unwrap();
    assert!(read_entry(&path, "magnolia-lock.json").is_none());
    assert!(read_entry(&path, "magnolia-project-id.json").is_none());
}

#[test]
fn every_save_stamps_the_editor() {
    let d = temp();
    let path = p(&d, "stamped.qdpx");
    make_zip(
        &path,
        &[
            ("project.qde", QDE),
            (
                "magnolia-editor.json",
                br#"{"lastEditedBy":"Carol","lastEditedAt":"2020-01-01T00:00:00.000Z"}"#,
            ),
        ],
    );
    let before = magnolia_core::util::now_iso();
    write_qdpx(
        &path,
        &mut empty_project(),
        &Map::new(),
        &opts(None, "Dave"),
    )
    .unwrap();
    let after = magnolia_core::util::now_iso();
    let info = json_entry(&path, "magnolia-editor.json").unwrap();
    assert_eq!(info["lastEditedBy"], "Dave");
    let at = info["lastEditedAt"].as_str().unwrap();
    assert!(at >= before.as_str() && at <= after.as_str());
    write_qdpx(&path, &mut empty_project(), &Map::new(), &opts(None, "")).unwrap();
    assert_eq!(
        json_entry(&path, "magnolia-editor.json").unwrap()["lastEditedBy"],
        ""
    );
}

#[test]
fn refuses_to_wipe_sources_with_an_empty_payload() {
    let d = temp();
    let path = p(&d, "full.qdpx");
    let xml = br#"<Project name="T"><Sources><TextSource guid="A" name="a"/></Sources></Project>"#;
    make_zip(&path, &[("project.qde", xml)]);
    let r = write_qdpx(&path, &mut empty_project(), &Map::new(), &opts(None, ""));
    assert!(matches!(r, Err(WriteError::Guard(_))));
    assert_eq!(read_entry(&path, "project.qde").unwrap(), xml);
}

// ── Writer + overlay binaries ──

const GUID: &str = "C06D37BE-2934-4343-B59C-F690339B066B";
const BYTES: &[u8] = b"not really an mp4, but bytes all the same";

fn project_with_video(handle: &str) -> Value {
    json!({ "name": "Test", "origin": "test", "users": [], "codes": [], "sets": [], "notes": [],
            "sources": [{ "guid": GUID, "name": "Beispielvideo.mp4", "sourceType": "video", "selections": [],
                          "formatData": { "videoFilePath": handle, "videoExt": "mp4", "mimeType": "video/mp4" } }] })
}

fn contents_for(guid: &str) -> Map<String, Value> {
    [(guid.to_string(), json!(""))].into_iter().collect()
}

#[test]
fn overlapping_saves_both_embed_the_binary() {
    let d = temp();
    let path = p(&d, "concurrent.qdpx");
    make_zip(&path, &[("project.qde", QDE)]);
    let store = BinaryStore::new();
    let handle = store.put_overlay(BYTES.to_vec(), "mp4");
    std::thread::scope(|s| {
        for _ in 0..2 {
            s.spawn(|| {
                write_qdpx(
                    &path,
                    &mut project_with_video(&handle),
                    &contents_for(GUID),
                    &opts(Some(&store), ""),
                )
                .unwrap();
            });
        }
    });
    assert_eq!(
        read_entry(&path, &format!("sources/{GUID}.mp4")).unwrap(),
        BYTES
    );
}

#[test]
fn failed_save_keeps_the_overlay_buffer() {
    let d = temp();
    let path = p(&d, "failing.qdpx");
    make_zip(&path, &[("project.qde", QDE)]);
    let store = BinaryStore::new();
    let handle = store.put_overlay(BYTES.to_vec(), "mp4");
    let mut project = project_with_video(&handle);
    project["sources"].as_array_mut().unwrap().push(json!({
        "guid": "MISSING", "name": "gone.mp4", "sourceType": "video", "selections": [],
        "formatData": { "videoFilePath": "magnolia-bin://archive/MISSING.mp4", "videoExt": "mp4" }
    }));
    match write_qdpx(
        &path,
        &mut project,
        &contents_for(GUID),
        &opts(Some(&store), ""),
    ) {
        Err(WriteError::Guard(m)) => assert!(m.contains("could not be located")),
        other => panic!("expected guard, got {other:?}"),
    }
    assert!(store.overlay_bytes(&handle).is_some());
}

#[test]
fn successful_save_frees_the_overlay_buffer() {
    let d = temp();
    let path = p(&d, "single.qdpx");
    make_zip(&path, &[("project.qde", QDE)]);
    let store = BinaryStore::new();
    store.set_active_project_path(Some(path.to_str().unwrap()));
    let handle = store.put_overlay(BYTES.to_vec(), "mp4");
    write_qdpx(
        &path,
        &mut project_with_video(&handle),
        &contents_for(GUID),
        &opts(Some(&store), ""),
    )
    .unwrap();
    assert!(store.overlay_bytes(&handle).is_none());
    // …and the handle now resolves from the archive.
    assert_eq!(store.resolve(&handle).unwrap().as_slice(), BYTES);
}

// ── Binary store ──

const AUDIO_GUID: &str = "ED6E609B-72F3-48E9-8DFB-EC04843AA865";
const AUDIO: &[u8] = &[0x00, 0x01, 0x02, 0x03, 0x52, 0x49, 0x46, 0x46];

fn audio_qdpx(d: &tempfile::TempDir, name: &str, guid: &str) -> String {
    let path = p(d, name);
    make_zip(&path, &[(&format!("sources/{guid}.m4a"), AUDIO)]);
    path.to_string_lossy().into_owned()
}

#[test]
fn resolves_archive_handles_by_guid_with_extension_fallback() {
    let d = temp();
    let store = BinaryStore::new();
    store.set_active_project_path(Some(&audio_qdpx(&d, "a.qdpx", AUDIO_GUID)));
    assert_eq!(
        store
            .resolve(&archive_handle(AUDIO_GUID, "m4a"))
            .unwrap()
            .as_slice(),
        AUDIO
    );
    assert_eq!(
        store
            .resolve(&archive_handle(AUDIO_GUID, "wav"))
            .unwrap()
            .as_slice(),
        AUDIO
    );
}

#[test]
fn overlay_resolves_from_memory_then_archive() {
    let d = temp();
    let path = audio_qdpx(&d, "c.qdpx", AUDIO_GUID);
    let store = BinaryStore::new();
    store.set_active_project_path(Some(&path));
    let handle = store.put_overlay(AUDIO.to_vec(), "m4a");
    assert_eq!(store.resolve(&handle).unwrap().as_slice(), AUDIO);
    store.mark_persisted(&handle, AUDIO_GUID);
    assert_eq!(store.resolve(&handle).unwrap().as_slice(), AUDIO);
    // Same-path re-assertion and a null path keep the mapping.
    store.note_active_project_path(Some(&path));
    store.set_active_project_path(Some(&path));
    store.set_active_project_path(None);
    assert!(store.resolve(&handle).is_some());
}

#[test]
fn switching_projects_drops_the_previous_overlay() {
    let d = temp();
    let store = BinaryStore::new();
    store.set_active_project_path(Some(&audio_qdpx(&d, "f.qdpx", AUDIO_GUID)));
    let handle = store.put_overlay(AUDIO.to_vec(), "m4a");
    store.mark_persisted(&handle, AUDIO_GUID);
    store.set_active_project_path(Some(&audio_qdpx(
        &d,
        "g.qdpx",
        "11111111-1111-1111-1111-111111111111",
    )));
    assert!(store.resolve(&handle).is_none());
}

#[test]
fn archive_file_name_from_handle_only_for_archive_handles() {
    assert_eq!(
        archive_file_name_from_handle("magnolia-bin://archive/ABC123.pdf").as_deref(),
        Some("ABC123.pdf")
    );
    assert!(archive_file_name_from_handle("magnolia-bin://overlay/tok1.pdf").is_none());
    assert!(archive_file_name_from_handle("/some/real/path.pdf").is_none());
}

#[test]
fn merge_binary_resolves_against_the_active_project() {
    let d = temp();
    let active = p(&d, "active.qdpx");
    let compare = p(&d, "compare.qdpx");
    make_zip(&active, &[("sources/unrelated.txt", b"n/a")]);
    make_zip(&compare, &[("sources/DOC3.pdf", b"%PDF")]);
    let store = BinaryStore::new();
    store.set_active_project_path(Some(active.to_str().unwrap()));
    let name = archive_file_name_from_handle(&archive_handle_for_file("DOC3.pdf")).unwrap();
    let bytes = read_archive_file(&compare, &name).unwrap();
    let handle = store.put_overlay(bytes, "pdf");
    assert_eq!(store.resolve(&handle).unwrap().as_slice(), b"%PDF");
}

// ── Round-trips through the reader ──

#[test]
fn notes_and_notebooks_survive_save_and_reopen() {
    let (note, notebook, code) = (
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
        "33333333-3333-4333-8333-333333333333",
    );
    let mut project = json!({
        "name": "Notes", "origin": "test", "users": [], "sets": [], "notes": [],
        "codes": [{ "guid": code, "name": "Queue", "isCodable": true, "children": [] }],
        "sources": [{ "guid": note, "name": "261027 14:32 - Market", "sourceType": "note",
                      "formatData": { "title": "Market", "noteDateTime": "2026-10-27T03:32:00.000Z" },
                      "selections": [{ "guid": "44444444-4444-4444-8444-444444444444", "name": "queue", "startPosition": 4, "endPosition": 9,
                                       "codings": [{ "guid": "55555555-5555-4555-8555-555555555555", "codeGuid": code }] }] }],
        "folders": [{ "guid": notebook, "name": "Field notes", "parentGuid": null, "kind": "notebook" }],
        "sourceFolder": { note: notebook }
    });
    let d = temp();
    let path = p(&d, "notes.qdpx");
    let contents: Map<String, Value> = [(note.to_string(), json!("The **queue** was long."))]
        .into_iter()
        .collect();
    write_qdpx(&path, &mut project, &contents, &opts(None, "")).unwrap();
    let back = read_qdpx(&path, None).unwrap();
    let src = back["sources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["guid"] == note)
        .unwrap();
    assert_eq!(src["sourceType"], "note");
    assert_eq!(src["name"], "261027 14:32 - Market");
    assert_eq!(
        src["formatData"],
        json!({ "title": "Market", "noteDateTime": "2026-10-27T03:32:00.000Z" })
    );
    assert_eq!(back["sourceContents"][note], "The **queue** was long.");
    let sel = &src["selections"][0];
    assert_eq!(
        (sel["startPosition"].as_i64(), sel["endPosition"].as_i64()),
        (Some(4), Some(9))
    );
    assert_eq!(sel["codings"][0]["codeGuid"], code);
    assert_eq!(
        back["folders"],
        json!([{ "guid": notebook, "name": "Field notes", "parentGuid": null, "kind": "notebook" }])
    );
    assert_eq!(back["sourceFolder"], json!({ note: notebook }));
}

#[test]
fn codebook_normalises_guids_and_round_trips() {
    let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<CodeBook xmlns="urn:QDA-XML:codebook:1.0"><Codes>
  <Code guid="{2a08bddf-4c35-4250-bf77-7de37b50c930}" name="parent" isCodable="true">
    <Code guid="2d969af8-c875-4fae-bcd8-f0162bc27396" name="child" isCodable="true"/>
  </Code>
</Codes></CodeBook>"#;
    let codes = deserialize_codebook(xml).unwrap();
    assert_eq!(codes[0]["guid"], "2A08BDDF-4C35-4250-BF77-7DE37B50C930");
    assert_eq!(
        codes[0]["children"][0]["guid"],
        "2D969AF8-C875-4FAE-BCD8-F0162BC27396"
    );

    let original = vec![json!({
        "guid": "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", "name": "theme", "isCodable": true, "color": "#FF8800", "description": "a theme",
        "children": [{ "guid": "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB", "name": "sub", "isCodable": false, "children": [] }]
    })];
    let restored = deserialize_codebook(&serialize_codebook(&original, APP_VERSION)).unwrap();
    assert_eq!(restored[0]["guid"], original[0]["guid"]);
    assert_eq!(restored[0]["children"][0]["isCodable"], false);
    assert_eq!(restored[0]["color"], "#FF8800");
    assert_eq!(restored[0]["description"], "a theme");
}
