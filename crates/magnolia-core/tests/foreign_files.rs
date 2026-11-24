//! Files written by other QDA programs, which use parts of the REFI-QDA
//! standard Magnolia doesn't write itself: what they hold must arrive (and,
//! saved again, stay valid).
mod common;
use common::*;
use magnolia_core::qdpx::reader::read_qdpx;
use magnolia_core::qdpx::serializer::serialize_project;
use magnolia_core::qdpx::writer::{WriteOptions, write_qdpx};
use serde_json::{Map, Value};

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
    read_and_resave(xml, files).0
}

/// The file as Magnolia opens it, and as Magnolia opens it again after
/// saving it.
fn read_and_resave(xml: &str, files: &[(&str, &[u8])]) -> (Value, Value, String) {
    let dir = temp();
    let path = p(&dir, "Elsewhere.qdpx");
    let mut entries: Vec<(&str, &[u8])> = vec![("project.qde", xml.as_bytes())];
    entries.extend_from_slice(files);
    make_zip(&path, &entries);
    let first = read_qdpx(&path, None).unwrap();
    let mut project = first.clone();
    let contents = match project.as_object_mut().unwrap().remove("sourceContents") {
        Some(Value::Object(m)) => m,
        _ => Map::new(),
    };
    let saved = p(&dir, "Saved.qdpx");
    let opts = WriteOptions { carry_forward_from: Some(&path), app_version: APP_VERSION, ..Default::default() };
    write_qdpx(&saved, &mut project, &contents, &opts).unwrap();
    let xml = String::from_utf8(zip_entry(&saved, "Elsewhere.qde").expect("the saved project's XML")).unwrap();
    (first, read_qdpx(&saved, None).unwrap(), xml)
}

fn source<'a>(project: &'a Value, name: &str) -> &'a Value {
    project["sources"].as_array().unwrap().iter().find(|s| s["name"] == name).unwrap_or_else(|| panic!("no source {name}"))
}

/// Each tag as "Category:value" → its documents' names, sorted.
fn tags(project: &Value) -> Vec<(String, Vec<String>)> {
    let name_of = |guid: &Value| {
        project["sources"].as_array().unwrap().iter().find(|s| &s["guid"] == guid).map(|s| s["name"].as_str().unwrap().to_string()).unwrap_or_default()
    };
    let category = |guid: &Value| {
        project["tagCategories"].as_array().into_iter().flatten().find(|c| &c["guid"] == guid).map(|c| c["name"].as_str().unwrap().to_string()).unwrap_or_default()
    };
    let mut out: Vec<(String, Vec<String>)> = project["sets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            let label = if s["categoryGuid"].is_string() {
                format!("{}:{}", category(&s["categoryGuid"]), s["value"].as_str().unwrap())
            } else {
                s["name"].as_str().unwrap().to_string()
            };
            let mut members: Vec<String> = s["memberSourceGuids"].as_array().unwrap().iter().map(name_of).collect();
            members.sort();
            (label, members)
        })
        .collect();
    out.sort();
    out
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

#[test]
fn a_coded_stretch_of_a_recording_is_saved_with_its_times() {
    let xml = project_xml(
        r#"<Sources>
  <AudioSource guid="40000000-0000-0000-0000-000000000004" name="interview.m4a" path="internal://40000000-0000-0000-0000-000000000004.m4a">
    <AudioSelection guid="50000000-0000-0000-0000-000000000006" begin="1250" end="5000">
      <Description>Laughs here</Description>
      <Coding guid="60000000-0000-0000-0000-000000000006" creatingUser="10000000-0000-0000-0000-000000000001">
        <CodeRef targetGUID="20000000-0000-0000-0000-000000000001"/>
      </Coding>
    </AudioSelection>
  </AudioSource>
</Sources>"#,
    );
    let (first, again, saved) = read_and_resave(&xml, &[("sources/40000000-0000-0000-0000-000000000004.m4a", b"not really audio")]);
    validate(&saved).unwrap();
    assert!(saved.contains("<AudioSelection"), "the coded stretch wasn't written");
    for project in [&first, &again] {
        let sels = source(project, "interview.m4a")["selections"].as_array().unwrap();
        assert_eq!(sels.len(), 1, "{sels:?}");
        assert_eq!(sels[0]["guid"], "50000000-0000-0000-0000-000000000006");
        assert_eq!(sels[0]["timeRange"]["startTime"], 1.25);
        assert_eq!(sels[0]["timeRange"]["endTime"], 5.0);
        assert_eq!(sels[0]["description"], "Laughs here");
        assert_eq!(sels[0]["codings"][0]["codeGuid"], "20000000-0000-0000-0000-000000000001");
    }
}

#[test]
fn a_comment_on_a_stretch_of_video_is_kept() {
    // Atlas.ti writes a quotation's comment as its Description, coded or not.
    let xml = project_xml(
        r#"<Sources>
  <VideoSource guid="40000000-0000-0000-0000-000000000005" name="clip.mp4" path="internal://40000000-0000-0000-0000-000000000005.mp4">
    <VideoSelection guid="50000000-0000-0000-0000-000000000007" name="9s" begin="9196" end="10361">
      <Description>Hello, trying this out</Description>
    </VideoSelection>
  </VideoSource>
</Sources>"#,
    );
    let (first, again, saved) = read_and_resave(&xml, &[("sources/40000000-0000-0000-0000-000000000005.mp4", b"not really video")]);
    validate(&saved).unwrap();
    for project in [&first, &again] {
        let sels = source(project, "clip.mp4")["selections"].as_array().unwrap();
        assert_eq!(sels.len(), 1, "{sels:?}");
        assert_eq!(sels[0]["description"], "Hello, trying this out");
        assert_eq!(sels[0]["timeRange"]["startTime"], 9.196);
    }
}

const TWO_INTERVIEWS: &str = r#"<Sources>
  <TextSource guid="40000000-0000-0000-0000-000000000001" name="Interview A.txt" plainTextPath="internal://40000000-0000-0000-0000-000000000001.txt">
    <PlainTextSelection guid="50000000-0000-0000-0000-000000000001" startPosition="0" endPosition="4">
      <Coding guid="60000000-0000-0000-0000-000000000001" creatingUser="10000000-0000-0000-0000-000000000001">
        <CodeRef targetGUID="20000000-0000-0000-0000-000000000001"/>
      </Coding>
    </PlainTextSelection>
  </TextSource>
  <TextSource guid="40000000-0000-0000-0000-000000000002" name="Interview B.txt" plainTextPath="internal://40000000-0000-0000-0000-000000000002.txt"/>
</Sources>"#;
const TWO_TEXTS: [(&str, &[u8]); 2] = [
    ("sources/40000000-0000-0000-0000-000000000001.txt", b"Diet and health."),
    ("sources/40000000-0000-0000-0000-000000000002.txt", b"Sleep and work."),
];

#[test]
fn cases_describing_documents_become_tags_on_them() {
    // As NVivo writes its cases: one per participant, with attribute values,
    // referring to that participant's interview.
    let xml = project_xml(&format!(
        r#"<Variables>
  <Variable guid="30000000-0000-0000-0000-000000000001" name="Age" typeOfVariable="Integer"/>
  <Variable guid="30000000-0000-0000-0000-000000000002" name="Consented" typeOfVariable="Boolean"/>
  <Variable guid="30000000-0000-0000-0000-000000000003" name="Country" typeOfVariable="Text"/>
</Variables>
<Cases>
  <Case guid="d0000000-0000-0000-0000-000000000001" name="Participant 1">
    <Description>Recruited in March.</Description>
    <VariableValue><VariableRef targetGUID="30000000-0000-0000-0000-000000000001"/><IntegerValue>34</IntegerValue></VariableValue>
    <VariableValue><VariableRef targetGUID="30000000-0000-0000-0000-000000000002"/><BooleanValue>true</BooleanValue></VariableValue>
    <VariableValue><VariableRef targetGUID="30000000-0000-0000-0000-000000000003"/><TextValue>Australia</TextValue></VariableValue>
    <SourceRef targetGUID="40000000-0000-0000-0000-000000000001"/>
  </Case>
  <Case guid="d0000000-0000-0000-0000-000000000002" name="Participant 2">
    <VariableValue><VariableRef targetGUID="30000000-0000-0000-0000-000000000001"/><IntegerValue>51</IntegerValue></VariableValue>
    <VariableValue><VariableRef targetGUID="30000000-0000-0000-0000-000000000003"/><TextValue>Australia</TextValue></VariableValue>
    <SourceRef targetGUID="40000000-0000-0000-0000-000000000002"/>
  </Case>
</Cases>
{TWO_INTERVIEWS}"#
    ));
    let (first, again, saved) = read_and_resave(&xml, &TWO_TEXTS);
    validate(&saved).unwrap();
    let a = |s: &str| s.to_string();
    let expected = vec![
        (a("Age:34"), vec![a("Interview A.txt")]),
        (a("Age:51"), vec![a("Interview B.txt")]),
        (a("Case:Participant 1"), vec![a("Interview A.txt")]),
        (a("Case:Participant 2"), vec![a("Interview B.txt")]),
        (a("Consented:true"), vec![a("Interview A.txt")]),
        (a("Country:Australia"), vec![a("Interview A.txt"), a("Interview B.txt")]),
    ];
    for project in [&first, &again] {
        // The documents and their coding stay.
        let names: Vec<&str> = project["sources"].as_array().unwrap().iter().map(|s| s["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["Interview A.txt", "Interview B.txt"]);
        assert_eq!(source(project, "Interview A.txt")["selections"][0]["codings"][0]["codeGuid"], "20000000-0000-0000-0000-000000000001");
        assert_eq!(project["sourceContents"]["40000000-0000-0000-0000-000000000001"], "Diet and health.");
        assert_eq!(tags(project), expected);
        let kind = |name: &str| project["tagCategories"].as_array().unwrap().iter().find(|c| c["name"] == name).unwrap()["type"].clone();
        assert_eq!(kind("Age"), "numeric");
        assert_eq!(kind("Country"), "text");
        let case = project["sets"].as_array().unwrap().iter().find(|s| s["value"] == "Participant 1").unwrap();
        assert_eq!(case["description"], "Recruited in March.");
    }
}

#[test]
fn a_documents_own_variable_values_become_tags_on_it() {
    // As MAXQDA writes its document variables.
    let xml = project_xml(
        r#"<Variables>
  <Variable guid="30000000-0000-0000-0000-000000000003" name="Country" typeOfVariable="Text"/>
  <Variable guid="30000000-0000-0000-0000-000000000004" name="Interviewed" typeOfVariable="Date"/>
</Variables>
<Sources>
  <TextSource guid="40000000-0000-0000-0000-000000000001" name="Interview A.txt" plainTextPath="internal://40000000-0000-0000-0000-000000000001.txt">
    <VariableValue><VariableRef targetGUID="30000000-0000-0000-0000-000000000003"/><TextValue>Fiji</TextValue></VariableValue>
    <VariableValue><VariableRef targetGUID="30000000-0000-0000-0000-000000000004"/><DateValue>2020-04-02</DateValue></VariableValue>
  </TextSource>
  <TextSource guid="40000000-0000-0000-0000-000000000002" name="Interview B.txt" plainTextPath="internal://40000000-0000-0000-0000-000000000002.txt">
    <VariableValue><VariableRef targetGUID="30000000-0000-0000-0000-000000000003"/><TextValue>Fiji</TextValue></VariableValue>
  </TextSource>
</Sources>"#,
    );
    let (first, again, saved) = read_and_resave(&xml, &TWO_TEXTS);
    validate(&saved).unwrap();
    let a = |s: &str| s.to_string();
    for project in [&first, &again] {
        assert_eq!(
            tags(project),
            vec![
                (a("Country:Fiji"), vec![a("Interview A.txt"), a("Interview B.txt")]),
                (a("Interviewed:2020-04-02"), vec![a("Interview A.txt")]),
            ]
        );
        assert!(project["sources"].as_array().unwrap().iter().all(|s| s.get("_refiVariableValues").is_none()));
        let categories: Vec<&str> = project["tagCategories"].as_array().unwrap().iter().map(|c| c["name"].as_str().unwrap()).collect();
        assert_eq!(categories, ["Country", "Interviewed"]);
    }
}

#[test]
fn cases_join_tags_the_project_already_has() {
    // A category and value the project has already (from its own Sets and
    // Magnolia's side table) are used, not made twice.
    let xml = project_xml(&format!(
        r#"<Variables><Variable guid="30000000-0000-0000-0000-000000000003" name="country" typeOfVariable="Text"/></Variables>
<Cases>
  <Case guid="d0000000-0000-0000-0000-000000000002" name="Participant 2">
    <VariableValue><VariableRef targetGUID="30000000-0000-0000-0000-000000000003"/><TextValue>Australia</TextValue></VariableValue>
    <SourceRef targetGUID="40000000-0000-0000-0000-000000000002"/>
  </Case>
</Cases>
{TWO_INTERVIEWS}
<Sets><Set guid="c0000000-0000-0000-0000-000000000001" name="Country:Australia"><MemberSource targetGUID="40000000-0000-0000-0000-000000000001"/></Set></Sets>"#
    ));
    let side = br#"{"categories":[{"guid":"e0000000-0000-0000-0000-000000000001","name":"Country","type":"text"}],"tagMeta":[{"guid":"C0000000-0000-0000-0000-000000000001","categoryGuid":"e0000000-0000-0000-0000-000000000001","value":"Australia"}]}"#;
    let files = [TWO_TEXTS[0], TWO_TEXTS[1], ("magnolia-tags.json", &side[..])];
    let project = read(&xml, &files);
    let a = |s: &str| s.to_string();
    assert_eq!(
        tags(&project),
        vec![
            (a("Case:Participant 2"), vec![a("Interview B.txt")]),
            (a("Country:Australia"), vec![a("Interview A.txt"), a("Interview B.txt")]),
        ]
    );
    assert_eq!(project["tagCategories"].as_array().unwrap().len(), 2);
}

#[test]
fn cases_without_documents_are_still_a_surveys_respondents() {
    let xml = project_xml(&format!(
        r#"<Variables><Variable guid="30000000-0000-0000-0000-000000000001" name="Age" typeOfVariable="Integer"/></Variables>
<Cases>
  <Case guid="d0000000-0000-0000-0000-000000000001" name="Respondent 1">
    <VariableValue><VariableRef targetGUID="30000000-0000-0000-0000-000000000001"/><IntegerValue>34</IntegerValue></VariableValue>
  </Case>
</Cases>
{TWO_INTERVIEWS}"#
    ));
    let project = read(&xml, &TWO_TEXTS);
    let survey = project["sources"].as_array().unwrap().iter().find(|s| s["sourceType"] == "survey").expect("a survey");
    assert_eq!(survey["formatData"]["survey"]["respondents"][0]["displayName"], "Respondent 1");
    assert_eq!(project["sources"].as_array().unwrap().len(), 3);
    assert!(project["sets"].as_array().unwrap().is_empty());
}

#[test]
fn what_cant_be_kept_is_counted_and_magnolias_own_save_reports_nothing() {
    // (The document's description and its whole-document coding are kept:
    // see the tests below.)
    let xml = project_xml(
        r#"<Sources>
  <TextSource guid="40000000-0000-0000-0000-000000000001" name="Interview A.txt" plainTextPath="internal://40000000-0000-0000-0000-000000000001.txt">
    <Description>Second interview with A.</Description>
    <PlainTextSelection guid="50000000-0000-0000-0000-000000000001" startPosition="0" endPosition="4">
      <Coding guid="60000000-0000-0000-0000-000000000001"><CodeRef targetGUID="20000000-0000-0000-0000-000000000001"/>
        <NoteRef targetGUID="a0000000-0000-0000-0000-000000000003"/></Coding>
      <NoteRef targetGUID="a0000000-0000-0000-0000-000000000002"/>
    </PlainTextSelection>
    <Coding guid="60000000-0000-0000-0000-000000000002"><CodeRef targetGUID="20000000-0000-0000-0000-000000000001"/></Coding>
    <NoteRef targetGUID="a0000000-0000-0000-0000-000000000001"/>
  </TextSource>
  <TextSource guid="40000000-0000-0000-0000-000000000002" name="Interview B.txt" plainTextPath="internal://40000000-0000-0000-0000-000000000002.txt">
    <Description>   </Description>
  </TextSource>
</Sources>
<Notes>
  <Note guid="a0000000-0000-0000-0000-000000000001" name="On A"><PlainTextContent>About A.</PlainTextContent></Note>
  <Note guid="a0000000-0000-0000-0000-000000000002" name="On a passage"><PlainTextContent>About diet.</PlainTextContent></Note>
  <Note guid="a0000000-0000-0000-0000-000000000003" name="On a coding"><PlainTextContent>Why coded.</PlainTextContent></Note>
</Notes>
<Links><Link guid="b0000000-0000-0000-0000-000000000001" originGUID="20000000-0000-0000-0000-000000000001" targetGUID="40000000-0000-0000-0000-000000000001"/></Links>
<Sets><Set guid="c0000000-0000-0000-0000-000000000001" name="Memos"><MemberNote targetGUID="a0000000-0000-0000-0000-000000000001"/></Set></Sets>"#,
    );
    let (first, again, _) = read_and_resave(&xml, &TWO_TEXTS);
    // The memos on the document and on the passage are kept attached; the
    // one on the coding isn't; the blank description doesn't count.
    assert_eq!(first["notKept"], serde_json::json!({ "links": 1, "memoAttachments": 1, "setMemos": 1 }));
    assert!(again.get("notKept").is_none(), "{:?}", again["notKept"]);
}

fn png(w: u32, h: u32) -> Vec<u8> {
    let mut out = std::io::Cursor::new(Vec::new());
    image::RgbImage::new(w, h).write_to(&mut out, image::ImageFormat::Png).unwrap();
    out.into_inner()
}

#[test]
fn whole_document_codings_cover_the_whole_document() {
    let xml = project_xml(
        r#"<Sources>
  <TextSource guid="40000000-0000-0000-0000-000000000001" name="Interview A.txt" plainTextPath="internal://40000000-0000-0000-0000-000000000001.txt">
    <Coding guid="60000000-0000-0000-0000-000000000002" creatingUser="10000000-0000-0000-0000-000000000001"><CodeRef targetGUID="20000000-0000-0000-0000-000000000001"/></Coding>
  </TextSource>
  <PictureSource guid="40000000-0000-0000-0000-000000000006" name="photo.png" path="internal://40000000-0000-0000-0000-000000000006.png">
    <Coding guid="60000000-0000-0000-0000-000000000003"><CodeRef targetGUID="20000000-0000-0000-0000-000000000001"/></Coding>
  </PictureSource>
</Sources>"#,
    );
    let photo = png(64, 48);
    let (first, again, saved) = read_and_resave(&xml, &[TWO_TEXTS[0], ("sources/40000000-0000-0000-0000-000000000006.png", &photo)]);
    validate(&saved).unwrap();
    assert!(first.get("notKept").is_none(), "{:?}", first["notKept"]);
    for project in [&first, &again] {
        let text = &source(project, "Interview A.txt")["selections"][0];
        assert_eq!((text["startPosition"].as_u64(), text["endPosition"].as_u64()), (Some(0), Some(16)), "{text}");
        assert_eq!(text["codings"][0]["guid"], "60000000-0000-0000-0000-000000000002");
        let picture = &source(project, "photo.png")["selections"][0];
        assert_eq!(picture["pdfRegion"], serde_json::json!({ "page": 1, "x": 0, "y": 0, "width": 64, "height": 48 }));
        assert_eq!(picture["codings"][0]["codeGuid"], "20000000-0000-0000-0000-000000000001");
    }
}

#[test]
fn memos_on_areas_stay_attached_and_descriptions_become_memos() {
    let xml = project_xml(
        r#"<Sources>
  <TextSource guid="40000000-0000-0000-0000-000000000001" name="Interview A.txt" plainTextPath="internal://40000000-0000-0000-0000-000000000001.txt">
    <Description>We have James under the Blob.</Description>
  </TextSource>
  <PictureSource guid="40000000-0000-0000-0000-000000000006" name="photo.png" path="internal://40000000-0000-0000-0000-000000000006.png">
    <PictureSelection guid="50000000-0000-0000-0000-000000000009" firstX="5" firstY="6" secondX="25" secondY="36">
      <Coding guid="60000000-0000-0000-0000-000000000009"><CodeRef targetGUID="20000000-0000-0000-0000-000000000001"/></Coding>
      <NoteRef targetGUID="a0000000-0000-0000-0000-000000000009"/>
    </PictureSelection>
  </PictureSource>
</Sources>
<Notes><Note guid="a0000000-0000-0000-0000-000000000009" name="On the face"><PlainTextContent>Smiling.</PlainTextContent></Note></Notes>"#,
    );
    let photo = png(64, 48);
    let (first, again, _) = read_and_resave(&xml, &[TWO_TEXTS[0], ("sources/40000000-0000-0000-0000-000000000006.png", &photo)]);
    assert!(first.get("notKept").is_none(), "{:?}", first["notKept"]);
    for project in [&first, &again] {
        let memos = project["memos"].as_array().unwrap();
        let on_face = memos.iter().find(|m| m["title"] == "On the face").unwrap();
        assert_eq!(on_face["type"], "content");
        assert_eq!(on_face["sourceGuid"], source(project, "photo.png")["guid"]);
        assert_eq!(on_face["pdfRegion"], serde_json::json!({ "page": 1, "x": 5, "y": 6, "width": 20, "height": 30 }));
        let described = memos.iter().find(|m| m["title"] == "Description of Interview A.txt").unwrap();
        assert_eq!(described["type"], "document");
        assert_eq!(described["content"], "We have James under the Blob.");
        assert_eq!(described["sourceGuids"][0], source(project, "Interview A.txt")["guid"]);
        assert_eq!(memos.len(), 2, "{memos:?}");
    }
}

/// A one-page PDF with the given boxes and rotation.
fn pdf(media: [i64; 4], crop: Option<[i64; 4]>, rotate: i64) -> Vec<u8> {
    use lopdf::{Document, Object, dictionary};
    let mut doc = Document::with_version("1.5");
    let pages_id = doc.new_object_id();
    let rect = |r: [i64; 4]| Object::Array(r.iter().map(|v| Object::Integer(*v)).collect());
    let mut page = dictionary! { "Type" => "Page", "Parent" => pages_id, "MediaBox" => rect(media), "Rotate" => rotate };
    if let Some(c) = crop {
        page.set("CropBox", rect(c));
    }
    let page_id = doc.add_object(page);
    doc.objects.insert(pages_id, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => vec![page_id.into()], "Count" => 1 }));
    let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    doc.trailer.set("Root", catalog);
    let mut out = Vec::new();
    doc.save_to(&mut out).unwrap();
    out
}

fn pdf_project(selection: &str) -> String {
    project_xml(&format!(
        r#"<Sources>
  <PDFSource guid="40000000-0000-0000-0000-000000000003" name="doc.pdf" path="internal://40000000-0000-0000-0000-000000000003.pdf">
    {selection}
    <Representation guid="70000000-0000-0000-0000-000000000003" plainTextPath="internal://70000000-0000-0000-0000-000000000003.txt">
      <PlainTextSelection guid="50000000-0000-0000-0000-000000000003" startPosition="12" endPosition="22">
        <Coding guid="60000000-0000-0000-0000-000000000003"><CodeRef targetGUID="20000000-0000-0000-0000-000000000001"/></Coding>
      </PlainTextSelection>
    </Representation>
  </PDFSource>
</Sources>"#
    ))
}
const REPRESENTATION: &str = "The reading Diet  study of the PDF, as its program made it.";

#[test]
fn a_pdfs_text_is_the_representation_its_file_carries() {
    let bytes = pdf([0, 0, 612, 792], None, 0);
    let (first, again, saved) = read_and_resave(
        &pdf_project(""),
        &[
            ("sources/40000000-0000-0000-0000-000000000003.pdf", &bytes),
            ("sources/70000000-0000-0000-0000-000000000003.txt", REPRESENTATION.as_bytes()),
        ],
    );
    validate(&saved).unwrap();
    for project in [&first, &again] {
        let guid = "40000000-0000-0000-0000-000000000003";
        assert_eq!(project["sourceContents"][guid], REPRESENTATION);
        let sel = &source(project, "doc.pdf")["selections"][0];
        // Exactly where the file put it: "Diet  stud".
        assert_eq!((sel["startPosition"].as_u64(), sel["endPosition"].as_u64()), (Some(12), Some(22)));
    }
    assert_eq!(first["sources"][0]["_textFromFile"], true);
}

#[test]
fn pdf_areas_are_read_and_written_as_the_standard_has_them() {
    // Page 1 (0 in the file); a crop box inset from the media box. The area
    // is 100 × 50 points, 72 in from the media box's left and 600 up from
    // its bottom.
    let area = r#"<PDFSelection guid="50000000-0000-0000-0000-000000000004" page="0" firstX="72" firstY="600" secondX="172" secondY="650">
      <Coding guid="60000000-0000-0000-0000-000000000004"><CodeRef targetGUID="20000000-0000-0000-0000-000000000001"/></Coding>
    </PDFSelection>"#;
    for (crop, rotate, drawn) in [
        // As drawn: top-left of the crop box, y down.
        (None, 0, serde_json::json!({ "page": 1, "x": 72, "y": 142, "width": 100, "height": 50 })),
        (Some([36, 36, 576, 756]), 0, serde_json::json!({ "page": 1, "x": 36, "y": 106, "width": 100, "height": 50 })),
        (Some([36, 36, 576, 756]), 90, serde_json::json!({ "page": 1, "x": 564, "y": 36, "width": 50, "height": 100 })),
    ] {
        let bytes = pdf([0, 0, 612, 792], crop, rotate);
        let (first, again, saved) = read_and_resave(
            &pdf_project(area),
            &[
                ("sources/40000000-0000-0000-0000-000000000003.pdf", &bytes),
                ("sources/70000000-0000-0000-0000-000000000003.txt", REPRESENTATION.as_bytes()),
            ],
        );
        validate(&saved).unwrap();
        let region = |p: &Value| {
            source(p, "doc.pdf")["selections"].as_array().unwrap().iter().find(|s| s["pdfRegion"].is_object()).unwrap()["pdfRegion"].clone()
        };
        assert_eq!(region(&first), drawn, "crop {crop:?} rotate {rotate}");
        assert_eq!(region(&again), drawn, "crop {crop:?} rotate {rotate}, after saving");
        // Written back exactly as it came.
        for (k, v) in [("page", 0), ("firstX", 72), ("firstY", 600), ("secondX", 172), ("secondY", 650)] {
            assert_eq!(int_attr(&saved, "PDFSelection", k), v, "{k}, crop {crop:?} rotate {rotate}");
        }
    }
}

#[test]
fn a_pdf_area_keeps_its_coordinates_when_the_pdf_is_missing() {
    let area = r#"<PDFSelection guid="50000000-0000-0000-0000-000000000004" page="2" firstX="72" firstY="600" secondX="172" secondY="650">
      <Coding guid="60000000-0000-0000-0000-000000000004"><CodeRef targetGUID="20000000-0000-0000-0000-000000000001"/></Coding>
    </PDFSelection>"#;
    let (_, _, saved) = read_and_resave(&pdf_project(area), &[("sources/70000000-0000-0000-0000-000000000003.txt", REPRESENTATION.as_bytes())]);
    for (k, v) in [("page", 2), ("firstX", 72), ("firstY", 600), ("secondX", 172), ("secondY", 650)] {
        assert_eq!(int_attr(&saved, "PDFSelection", k), v, "{k}");
    }
}
