//! Files written by other QDA programs, which use parts of the REFI-QDA
//! standard Magnolia doesn't write itself: what they hold must arrive (and,
//! saved again, stay valid).
mod common;
use common::*;
use magnolia_core::qdpx::reader::read_qdpx;
use magnolia_core::qdpx::serializer::serialize_project;
use serde_json::Value;

const USER: &str = "10000000-0000-0000-0000-000000000001";

fn project_xml(body: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<Project xmlns="urn:QDA-XML:project:1.0" name="Elsewhere" origin="Another program" creatingUserGUID="{USER}">
<Users><User guid="{USER}" name="Researcher"/></Users>
<CodeBook><Codes><Code guid="20000000-0000-0000-0000-000000000001" name="Diet" isCodable="true"/></Codes></CodeBook>
{body}
</Project>"#
    )
}

fn read(xml: &str, files: &[(&str, &[u8])]) -> Value {
    let dir = temp();
    let path = p(&dir, "Elsewhere.qdpx");
    let mut entries: Vec<(&str, &[u8])> = vec![("project.qde", xml.as_bytes())];
    entries.extend_from_slice(files);
    make_zip(&path, &entries);
    read_qdpx(&path, None).unwrap()
}

#[test]
fn a_notes_inline_text_is_its_memos_text() {
    // The schema lets a note hold its text inline instead of in a file.
    let xml = project_xml(
        r#"<Notes>
  <Note guid="a0000000-0000-0000-0000-000000000001" name="Research memo">
    <PlainTextContent>Remember to follow up on diet.</PlainTextContent>
  </Note>
  <Note guid="a0000000-0000-0000-0000-000000000002" name="Memo in a file" plainTextPath="internal://b0000000-0000-0000-0000-000000000002.txt"/>
</Notes>"#,
    );
    let project = read(&xml, &[("sources/b0000000-0000-0000-0000-000000000002.txt", b"Kept in a file.")]);
    let memo = |title: &str| {
        project["memos"].as_array().unwrap().iter().find(|m| m["title"] == title).cloned().unwrap()
    };
    assert_eq!(memo("Research memo")["content"], "Remember to follow up on diet.");
    assert_eq!(memo("Memo in a file")["content"], "Kept in a file.");
}

#[test]
fn a_coded_stretch_of_a_recording_arrives_with_its_times() {
    let xml = project_xml(
        r#"<Sources>
  <AudioSource guid="40000000-0000-0000-0000-000000000004" name="interview.m4a" path="internal://40000000-0000-0000-0000-000000000004.m4a">
    <AudioSelection guid="50000000-0000-0000-0000-000000000006" begin="1000" end="5000">
      <Coding guid="60000000-0000-0000-0000-000000000006" creatingUser="10000000-0000-0000-0000-000000000001">
        <CodeRef targetGUID="20000000-0000-0000-0000-000000000001"/>
      </Coding>
    </AudioSelection>
  </AudioSource>
</Sources>"#,
    );
    let project = read(&xml, &[("sources/40000000-0000-0000-0000-000000000004.m4a", b"not really audio")]);
    let audio = project["sources"].as_array().unwrap().iter().find(|s| s["sourceType"] == "audio").unwrap();
    let sels = audio["selections"].as_array().unwrap();
    assert_eq!(sels.len(), 1, "{sels:?}");
    assert_eq!(sels[0]["guid"], "50000000-0000-0000-0000-000000000006");
    assert_eq!(sels[0]["timeRange"]["startTime"], 1.0);
    assert_eq!(sels[0]["timeRange"]["endTime"], 5.0);
    assert_eq!(sels[0]["codings"][0]["codeGuid"], "20000000-0000-0000-0000-000000000001");
}

#[test]
fn codings_without_a_creator_are_saved_valid() {
    // Another program's codings may have no creatingUser (it's optional); an
    // empty one written back isn't a valid GUID.
    let xml = project_xml(
        r#"<Sources>
  <TextSource guid="40000000-0000-0000-0000-000000000001" name="Interview.txt" plainTextPath="internal://40000000-0000-0000-0000-000000000001.txt">
    <PlainTextSelection guid="50000000-0000-0000-0000-000000000001" startPosition="0" endPosition="4">
      <Coding guid="60000000-0000-0000-0000-000000000001">
        <CodeRef targetGUID="20000000-0000-0000-0000-000000000001"/>
      </Coding>
    </PlainTextSelection>
  </TextSource>
</Sources>"#,
    );
    let project = read(&xml, &[("sources/40000000-0000-0000-0000-000000000001.txt", b"Diet and health.")]);
    let saved = serialize_project(&project, APP_VERSION);
    assert!(!saved.contains(r#"creatingUser="""#), "an empty creatingUser was written");
    assert!(!saved.contains(r#"creatingUser="null""#), "a null creatingUser was written");
    validate(&saved).unwrap();
}
