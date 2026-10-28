//! REFI-QDA XML: schema compliance, element ordering and round-trips
//! (ported from test/qdpx/refi-schema.test.ts and pdf-selection.test.ts).

mod common;
use common::*;
use magnolia_core::qdpx::deserializer::deserialize_project;
use magnolia_core::qdpx::serializer::serialize_project;
use serde_json::{Value, json};

const U: &str = "00000000-0000-0000-0000-000000000001";
const DT: &str = "2024-01-01T00:00:00Z";

/// Every source type, nested codes, a Set with both code and source members
/// (the ordering regression), memos, and image/video region codings.
fn comprehensive_project() -> Value {
    let code_a = "11111111-1111-1111-1111-111111111111";
    let code_child = "11111111-1111-1111-1111-1111111111AA";
    let text = "22222222-2222-2222-2222-222222222222";
    let pdf = "33333333-3333-3333-3333-333333333333";
    json!({
        "name": "Comprehensive Test Project",
        "origin": "Magnolia test",
        "description": "A **markdown** project description with <special> & \"chars\".",
        "creatingUserGUID": U, "creationDateTime": DT,
        "users": [{ "guid": U, "name": "Tester", "id": "u1" }],
        "codes": [{
            "guid": code_a, "name": "Theme & <Sub>", "isCodable": true, "color": "#FF8800",
            "description": "A top-level code with special chars",
            "children": [{ "guid": code_child, "name": "Child code", "isCodable": true, "color": "#00AA00", "children": [] }]
        }],
        "sources": [
            { "guid": text, "name": "Interview 1", "sourceType": "text", "plainTextContent": "The quick brown fox.",
              "selections": [{ "guid": "22222222-2222-2222-2222-0000000000A1", "startPosition": 4, "endPosition": 9,
                "creatingUser": U, "creationDateTime": DT,
                "codings": [{ "guid": "22222222-2222-2222-2222-0000000000C1", "codeGuid": code_a, "creatingUser": U, "creationDateTime": DT }] }] },
            { "guid": pdf, "name": "Report", "sourceType": "pdf", "creatingUser": U, "creationDateTime": DT,
              "selections": [{ "guid": "33333333-3333-3333-3333-0000000000A1", "startPosition": 0, "endPosition": 10,
                "codings": [{ "guid": "33333333-3333-3333-3333-0000000000C1", "codeGuid": code_child, "creatingUser": U, "creationDateTime": DT }] }] },
            { "guid": "44444444-4444-4444-4444-444444444444", "name": "Photo", "sourceType": "image", "formatData": { "imageExt": "png" },
              "selections": [{ "guid": "44444444-4444-4444-4444-0000000000A1", "startPosition": 0, "endPosition": 0,
                "pdfRegion": { "page": 1, "x": 10.6, "y": 20.2, "width": 100.9, "height": 50.1 },
                "codings": [{ "guid": "44444444-4444-4444-4444-0000000000C1", "codeGuid": code_a, "creatingUser": U, "creationDateTime": DT }] }] },
            { "guid": "55555555-5555-5555-5555-555555555555", "name": "Recording", "sourceType": "audio", "formatData": { "audioExt": "m4a" }, "selections": [] },
            { "guid": "66666666-6666-6666-6666-666666666666", "name": "Clip", "sourceType": "video", "formatData": { "videoExt": "mp4" },
              "selections": [{ "guid": "66666666-6666-6666-6666-0000000000A1", "startPosition": 0, "endPosition": 0,
                "timeRange": { "startTime": 1.5, "endTime": 3.25 },
                "codings": [{ "guid": "66666666-6666-6666-6666-0000000000C1", "codeGuid": code_a, "creatingUser": U, "creationDateTime": DT }] }] }
        ],
        "sets": [{ "guid": "77777777-7777-7777-7777-777777777777", "name": "Mixed set", "description": "Carries both code and source members",
                   "memberCodeGuids": [code_a, code_child], "memberSourceGuids": [text, pdf] }],
        "notes": [],
        "memos": [{ "guid": "88888888-8888-8888-8888-888888888888", "type": "project", "title": "Project memo",
                    "content": "Some thoughts about the project.", "createdDateTime": DT, "modifiedDateTime": DT }]
    })
}

fn survey_project() -> Value {
    let survey = json!({
        "name": "Survey",
        "columns": [
            { "id": "m1", "index": 0, "rawHeader": "Country", "rawSubhead": "", "cleanHeader": "Country", "cleanSubhead": "", "type": "metadata" },
            { "id": "c1", "index": 1, "rawHeader": "Gender", "rawSubhead": "Response", "cleanHeader": "Gender", "cleanSubhead": "Response", "type": "single-choice" },
            { "id": "n1", "index": 2, "rawHeader": "Age", "rawSubhead": "Response", "cleanHeader": "Age", "cleanSubhead": "Response", "type": "numeric" },
            { "id": "o1", "index": 3, "rawHeader": "Why?", "rawSubhead": "Response", "cleanHeader": "Why?", "cleanSubhead": "Response", "type": "open-ended" }
        ],
        "questions": [
            { "id": "q-gender", "text": "Gender", "rawText": "Gender", "type": "single-choice", "columns": [{ "columnId": "c1", "optionLabel": "Response" }] },
            { "id": "q-age", "text": "Age", "rawText": "Age", "type": "numeric", "columns": [{ "columnId": "n1", "optionLabel": "Response" }] },
            { "id": "q-why", "text": "Why?", "rawText": "Why?", "type": "open-ended", "columns": [{ "columnId": "o1", "optionLabel": "Response" }] }
        ],
        "metadataColumnIds": ["m1"],
        "respondents": [{ "id": "r1", "displayName": "Alice", "metadata": { "m1": "Australia" },
                          "answers": { "q-gender": "F", "q-age": "30", "q-why": "Because reasons" } }]
    });
    json!({
        "name": "Survey Project", "origin": "Magnolia test", "creatingUserGUID": U, "creationDateTime": DT,
        "users": [{ "guid": U, "name": "Tester" }], "codes": [],
        "sources": [{ "guid": "99999999-9999-9999-9999-999999999999", "name": "Survey", "sourceType": "survey",
                      "selections": [], "formatData": { "survey": survey, "rawCsv": "" } }],
        "sets": [], "notes": []
    })
}

#[test]
fn comprehensive_project_validates_against_xsd() {
    validate(&serialize_project(&comprehensive_project(), APP_VERSION)).unwrap();
}

#[test]
fn survey_project_validates_against_xsd() {
    validate(&serialize_project(&survey_project(), APP_VERSION)).unwrap();
}

#[test]
fn set_member_code_precedes_member_source() {
    let xml = serialize_project(&comprehensive_project(), APP_VERSION);
    let code = xml.find("<MemberCode").unwrap();
    let source = xml.find("<MemberSource").unwrap();
    assert!(code < source);
}

#[test]
fn validator_rejects_wrong_set_member_order() {
    let wrong = r#"<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<Project xmlns="urn:QDA-XML:project:1.0" name="T">
  <Sets>
    <Set guid="22222222-2222-2222-2222-222222222222" name="S">
      <MemberSource targetGUID="33333333-3333-3333-3333-333333333333"/>
      <MemberCode targetGUID="11111111-1111-1111-1111-111111111111"/>
    </Set>
  </Sets>
</Project>"#;
    if std::process::Command::new("xmllint")
        .arg("--version")
        .output()
        .is_ok()
    {
        assert!(validate(wrong).is_err());
    }
}

#[test]
fn comprehensive_project_round_trips() {
    let original = comprehensive_project();
    let restored = deserialize_project(&serialize_project(&original, APP_VERSION)).unwrap();
    assert_eq!(restored["name"], original["name"]);
    assert_eq!(restored["description"], original["description"]);
    assert_eq!(restored["codes"].as_array().unwrap().len(), 1);
    assert_eq!(
        restored["codes"][0]["children"].as_array().unwrap().len(),
        1
    );
    assert_eq!(restored["codes"][0]["name"], "Theme & <Sub>");
    assert_eq!(restored["sources"].as_array().unwrap().len(), 5);
    assert_eq!(
        restored["sets"][0]["memberCodeGuids"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        restored["sets"][0]["memberSourceGuids"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn image_region_coordinates_are_rounded_integers() {
    let xml = serialize_project(&comprehensive_project(), APP_VERSION);
    assert_eq!(int_attr(&xml, "PictureSelection", "firstX"), 11);
    assert_eq!(int_attr(&xml, "PictureSelection", "secondX"), 112);
}

// ── PDF box codings → <PDFSelection> ──

const PDF: &str = "A0000000-0000-4000-8000-0000000000DF";
const CODE: &str = "C0000000-0000-4000-8000-00000000C0DE";
const PAGE_HEIGHT: i64 = 842;

fn pdf_project() -> Value {
    json!({
        "name": "PDF Project", "origin": "Magnolia test",
        "users": [{ "guid": "00000000-0000-4000-8000-000000000001", "name": "T" }],
        "codes": [{ "guid": CODE, "name": "theme", "isCodable": true, "children": [] }],
        "sources": [{
            "guid": PDF, "name": "Doc.pdf", "sourceType": "pdf",
            "formatData": { "pdfPageSizes": [{ "width": 0, "height": 0 }, { "width": 595, "height": PAGE_HEIGHT }] },
            "selections": [
                { "guid": "B0000000-0000-4000-8000-000000000001", "startPosition": 0, "endPosition": 0,
                  "pdfRegion": { "page": 1, "x": 130, "y": 64, "width": 333, "height": 279 },
                  "codings": [{ "guid": "B0000000-0000-4000-8000-0000000000C1", "codeGuid": CODE }] },
                { "guid": "B0000000-0000-4000-8000-000000000002", "startPosition": 10, "endPosition": 40,
                  "codings": [{ "guid": "B0000000-0000-4000-8000-0000000000C2", "codeGuid": CODE }] }
            ]
        }],
        "sets": [], "notes": []
    })
}

#[test]
fn pdf_project_validates_against_xsd() {
    validate(&serialize_project(&pdf_project(), APP_VERSION)).unwrap();
}

#[test]
fn box_coding_becomes_flipped_pdf_selection_before_representation() {
    let xml = serialize_project(&pdf_project(), APP_VERSION);
    assert!(xml.find("<PDFSelection").unwrap() < xml.find("<Representation").unwrap());
    assert_eq!(int_attr(&xml, "PDFSelection", "page"), 0);
    assert_eq!(int_attr(&xml, "PDFSelection", "firstX"), 130);
    assert_eq!(int_attr(&xml, "PDFSelection", "secondX"), 463);
    assert_eq!(
        int_attr(&xml, "PDFSelection", "firstY"),
        PAGE_HEIGHT - (64 + 279)
    );
    assert_eq!(int_attr(&xml, "PDFSelection", "secondY"), PAGE_HEIGHT - 64);
}

#[test]
fn text_coding_stays_a_plain_text_selection() {
    let xml = serialize_project(&pdf_project(), APP_VERSION);
    assert!(
        regex::Regex::new(r#"<PlainTextSelection[^>]*startPosition="10"[^>]*endPosition="40""#)
            .unwrap()
            .is_match(&xml)
    );
    assert_eq!(xml.matches("<PDFSelection").count(), 1);
}

#[test]
fn box_coding_falls_back_to_top_left_without_page_height() {
    let mut p = pdf_project();
    p["sources"][0]["formatData"] = json!({});
    let xml = serialize_project(&p, APP_VERSION);
    assert_eq!(int_attr(&xml, "PDFSelection", "firstY"), 64);
    assert_eq!(int_attr(&xml, "PDFSelection", "secondY"), 64 + 279);
}

// ── MAXQDA source types ──

const MAXQDA_XML: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<Project origin="MAXQDA 2020 (Release 20.4.2)" xmlns="urn:QDA-XML:project:1.0" name="New project">
 <Sources>
  <TextSource plainTextPath="internal://A.txt" guid="A" name="RTF"/>
  <PictureSource path="internal://B.jpg" guid="B" name="Screenshot 2026-06-24 at 16.41.21"/>
  <PictureSource path="internal://C.jpg" guid="C" name="magnoliasolid"/>
  <TextSource plainTextPath="internal://D.txt" guid="D" name="Video-transcript"/>
  <VideoSource path="internal://E.m4a" guid="E" name="New Recording 11"/>
 </Sources>
</Project>"#;

fn source_type(xml: &str, name: &str) -> String {
    let p = deserialize_project(xml).unwrap();
    p["sources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["name"] == name)
        .unwrap()["sourceType"]
        .as_str()
        .unwrap()
        .to_string()
}

#[test]
fn maxqda_picture_source_is_image() {
    assert_eq!(
        source_type(MAXQDA_XML, "Screenshot 2026-06-24 at 16.41.21"),
        "image"
    );
    assert_eq!(source_type(MAXQDA_XML, "magnoliasolid"), "image");
}

#[test]
fn maxqda_video_source_with_m4a_is_audio() {
    assert_eq!(source_type(MAXQDA_XML, "New Recording 11"), "audio");
    assert_eq!(
        source_type(
            &MAXQDA_XML.replace("internal://E.m4a", "internal://E.mp4"),
            "New Recording 11"
        ),
        "video"
    );
}

// ── Reader leniency ──

#[test]
fn reads_value_less_boolean_attributes_written_by_old_magnolia() {
    let xml = r##"<Project xmlns="urn:QDA-XML:project:1.0" name="Old"><CodeBook><Codes>
      <Code guid="37456066-acb3-45b9-8675-502589dd798b" name="Earth" isCodable color="#e05050"/>
    </Codes></CodeBook></Project>"##;
    let p = deserialize_project(xml).unwrap();
    assert_eq!(p["codes"][0]["isCodable"], true);
    assert_eq!(p["codes"][0]["color"], "#e05050");
    assert_eq!(
        p["codes"][0]["guid"],
        "37456066-ACB3-45B9-8675-502589DD798B"
    );
}

#[test]
fn keeps_newlines_in_attribute_values() {
    let p = json!({ "name": "N", "users": [], "codes": [], "sets": [], "notes": [],
        "sources": [{ "guid": "11111111-1111-1111-1111-111111111111", "name": "T", "plainTextContent": "x",
            "selections": [{ "guid": "21111111-1111-1111-1111-111111111111", "name": "line one\n\nline two",
                             "startPosition": 0, "endPosition": 1, "codings": [] }] }] });
    let back = deserialize_project(&serialize_project(&p, APP_VERSION)).unwrap();
    assert_eq!(
        back["sources"][0]["selections"][0]["name"],
        "line one\n\nline two"
    );
}
