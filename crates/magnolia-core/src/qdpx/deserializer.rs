//! REFI-QDA project XML (.qde) → Magnolia project JSON.
//!
//! Produces the same shape the renderer's `Project` type expects, plus a
//! handful of transient underscore-prefixed fields (`_refiVariables`,
//! `_rawPdfSelections`, …) that `reader` consumes and strips before the
//! project reaches the renderer.

use crate::util::{Obj, js_parse_float, js_parse_int, normalize_guid, num, set_opt};
use crate::xml_read::{attr, child, child_text, children, list};
use roxmltree::Node;
use serde_json::{Map, Value, json};

/// Media extensions that are audio-only. MAXQDA (and some other tools) store
/// audio recordings as `<VideoSource>`, so the file extension wins over the
/// element name and these route to the audio viewer.
const AUDIO_EXTENSIONS: &[&str] = &["wav", "mp3", "ogg", "flac", "m4a", "aac"];

fn guid_attr(n: Node, name: &str) -> String {
    normalize_guid(attr(n, name).as_deref())
}

fn int_attr(n: Node, name: &str) -> Value {
    js_parse_int(attr(n, name).as_deref())
        .map(Value::from)
        .unwrap_or(Value::Null)
}

fn float_attr(n: Node, name: &str) -> Value {
    js_parse_float(attr(n, name).as_deref())
        .map(num)
        .unwrap_or(Value::Null)
}

/// The creating/modifying user + timestamp attributes every source and
/// selection carries. Users are normalised to `""` when absent (the TS code
/// always set the key); timestamps are omitted when absent.
fn audit_fields(o: &mut Obj, n: Node) {
    o.insert("creatingUser".into(), guid_attr(n, "creatingUser").into());
    set_opt(o, "creationDateTime", attr(n, "creationDateTime"));
    o.insert("modifyingUser".into(), guid_attr(n, "modifyingUser").into());
    set_opt(o, "modifiedDateTime", attr(n, "modifiedDateTime"));
}

fn parse_code(n: Node) -> Value {
    let mut o = Obj::new();
    o.insert("guid".into(), guid_attr(n, "guid").into());
    o.insert("name".into(), attr(n, "name").unwrap_or_default().into());
    o.insert(
        "isCodable".into(),
        (attr(n, "isCodable").as_deref() != Some("false")).into(),
    );
    set_opt(&mut o, "color", attr(n, "color"));
    set_opt(&mut o, "description", child_text(n, "Description"));
    o.insert(
        "children".into(),
        children(n, "Code")
            .map(parse_code)
            .collect::<Vec<_>>()
            .into(),
    );
    Value::Object(o)
}

pub fn parse_coding(n: Node) -> Value {
    let code_guid = child(n, "CodeRef")
        .map(|r| guid_attr(r, "targetGUID"))
        .unwrap_or_default();
    let mut o = Obj::new();
    o.insert("guid".into(), guid_attr(n, "guid").into());
    o.insert("codeGuid".into(), code_guid.into());
    o.insert("creatingUser".into(), guid_attr(n, "creatingUser").into());
    set_opt(&mut o, "creationDateTime", attr(n, "creationDateTime"));
    Value::Object(o)
}

fn codings(n: Node) -> Value {
    children(n, "Coding")
        .map(parse_coding)
        .collect::<Vec<_>>()
        .into()
}

fn parse_selection(n: Node) -> Value {
    let mut o = Obj::new();
    o.insert("guid".into(), guid_attr(n, "guid").into());
    set_opt(&mut o, "name", attr(n, "name"));
    o.insert("startPosition".into(), int_attr(n, "startPosition"));
    o.insert("endPosition".into(), int_attr(n, "endPosition"));
    audit_fields(&mut o, n);
    set_opt(&mut o, "description", child_text(n, "Description"));
    o.insert("codings".into(), codings(n));
    Value::Object(o)
}

/// A `<PlainTextSelection>` carrying only a `<NoteRef>` (no `<Coding>`) is a
/// memo anchor, not a coding — it must not surface as an uncoded highlight.
fn is_memo_anchor_selection(n: Node) -> bool {
    child(n, "NoteRef").is_some() && child(n, "Coding").is_none()
}

fn base_source(n: Node, source_type: Option<&str>, path_attr: &str) -> Obj {
    let mut o = Obj::new();
    o.insert("guid".into(), guid_attr(n, "guid").into());
    o.insert("name".into(), attr(n, "name").unwrap_or_default().into());
    if let Some(t) = source_type {
        o.insert("sourceType".into(), t.into());
    }
    set_opt(&mut o, "plainTextPath", attr(n, path_attr));
    o
}

fn parse_text_source(n: Node) -> Value {
    let mut o = base_source(n, None, "plainTextPath");
    set_opt(
        &mut o,
        "plainTextContent",
        child_text(n, "PlainTextContent"),
    );
    set_opt(&mut o, "richTextPath", attr(n, "richTextPath"));
    audit_fields(&mut o, n);
    let sels: Vec<Value> = children(n, "PlainTextSelection")
        .filter(|s| !is_memo_anchor_selection(*s))
        .map(parse_selection)
        .collect();
    o.insert("selections".into(), sels.into());
    Value::Object(o)
}

fn rect_selection(n: Node, with_page: bool) -> Value {
    let mut o = Obj::new();
    o.insert("guid".into(), guid_attr(n, "guid").into());
    set_opt(&mut o, "name", attr(n, "name"));
    if with_page {
        o.insert("page".into(), int_attr(n, "page"));
    }
    for k in ["firstX", "firstY", "secondX", "secondY"] {
        o.insert(k.into(), float_attr(n, k));
    }
    audit_fields(&mut o, n);
    o.insert("codings".into(), codings(n));
    Value::Object(o)
}

fn parse_picture_source(n: Node) -> Value {
    let mut o = base_source(n, Some("image"), "path");
    audit_fields(&mut o, n);
    o.insert("selections".into(), json!([]));
    let raw: Vec<Value> = children(n, "PictureSelection")
        .map(|s| rect_selection(s, false))
        .collect();
    if !raw.is_empty() {
        o.insert("_rawPictureSelections".into(), raw.into());
    }
    Value::Object(o)
}

fn parse_video_selection(n: Node) -> Value {
    let mut o = Obj::new();
    o.insert("guid".into(), guid_attr(n, "guid").into());
    set_opt(&mut o, "name", attr(n, "name"));
    let ms = |k: &str| {
        js_parse_int(Some(attr(n, k).as_deref().unwrap_or("0")))
            .map(Value::from)
            .unwrap_or(Value::Null)
    };
    o.insert("begin".into(), ms("begin"));
    o.insert("end".into(), ms("end"));
    audit_fields(&mut o, n);
    o.insert("codings".into(), codings(n));
    Value::Object(o)
}

/// Parse the first `<Transcript>` of an audio/video source: its text path,
/// the SyncPoints pinning text offsets to media times, and any coded
/// `<TranscriptSelection>`s.
fn parse_transcript(n: Node) -> Option<Value> {
    let t = child(n, "Transcript")?;
    let int_opt = |n: Node, k: &str| js_parse_int(attr(n, k).as_deref());
    let sync_points: Vec<Value> = children(t, "SyncPoint")
        .map(|sp| {
            let mut o = Obj::new();
            o.insert("guid".into(), guid_attr(sp, "guid").into());
            set_opt(&mut o, "timeStamp", int_opt(sp, "timeStamp"));
            set_opt(&mut o, "position", int_opt(sp, "position"));
            Value::Object(o)
        })
        .collect();
    let selections: Vec<Value> = children(t, "TranscriptSelection")
        .map(|ts| {
            let mut o = Obj::new();
            o.insert("guid".into(), guid_attr(ts, "guid").into());
            set_opt(&mut o, "name", attr(ts, "name"));
            set_opt(
                &mut o,
                "fromSyncPoint",
                attr(ts, "fromSyncPoint")
                    .filter(|s| !s.is_empty())
                    .map(|s| normalize_guid(Some(&s))),
            );
            set_opt(
                &mut o,
                "toSyncPoint",
                attr(ts, "toSyncPoint")
                    .filter(|s| !s.is_empty())
                    .map(|s| normalize_guid(Some(&s))),
            );
            set_opt(
                &mut o,
                "creatingUser",
                Some(guid_attr(ts, "creatingUser")).filter(|s| !s.is_empty()),
            );
            set_opt(&mut o, "creationDateTime", attr(ts, "creationDateTime"));
            o.insert("codings".into(), codings(ts));
            Value::Object(o)
        })
        .collect();
    Some(json!({
        "guid": guid_attr(t, "guid"),
        "plainTextPath": attr(t, "plainTextPath").unwrap_or_default(),
        "syncPoints": sync_points,
        "selections": selections,
    }))
}

fn parse_video_source(n: Node) -> Value {
    let path_ext = crate::util::ext_of(&attr(n, "path").unwrap_or_default());
    let is_audio = AUDIO_EXTENSIONS.contains(&path_ext.as_str());
    let mut o = base_source(n, Some(if is_audio { "audio" } else { "video" }), "path");
    audit_fields(&mut o, n);
    o.insert("selections".into(), json!([]));
    let raw: Vec<Value> = children(n, "VideoSelection")
        .map(parse_video_selection)
        .collect();
    if !raw.is_empty() {
        o.insert("_rawVideoSelections".into(), raw.into());
    }
    if let Some(t) = parse_transcript(n) {
        o.insert("_refiTranscript".into(), t);
    }
    Value::Object(o)
}

fn parse_audio_source(n: Node) -> Value {
    let mut o = base_source(n, Some("audio"), "path");
    audit_fields(&mut o, n);
    o.insert("selections".into(), json!([]));
    if let Some(t) = parse_transcript(n) {
        o.insert("_refiTranscript".into(), t);
    }
    Value::Object(o)
}

/// A `<PDFSource>`. Rectangle `<PDFSelection>`s ride on the transient
/// `_rawPdfSelections` for the reader to convert; char-offset selections are
/// accepted both inside the `<Representation>` (the schema's placement) and
/// directly on the source (legacy Magnolia files).
fn parse_pdf_source(n: Node) -> Value {
    let mut o = base_source(n, Some("pdf"), "path");
    audit_fields(&mut o, n);
    let repr = child(n, "Representation");
    if let Some(p) = repr.and_then(|r| attr(r, "plainTextPath")) {
        o.insert("_representationPlainTextPath".into(), p.into());
    }
    let raw: Vec<Value> = children(n, "PDFSelection")
        .map(|s| rect_selection(s, true))
        .collect();
    if !raw.is_empty() {
        o.insert("_rawPdfSelections".into(), raw.into());
    }
    let mut sels: Vec<Value> = repr
        .map(|r| {
            children(r, "PlainTextSelection")
                .map(parse_selection)
                .collect()
        })
        .unwrap_or_default();
    sels.extend(children(n, "PlainTextSelection").map(parse_selection));
    o.insert("selections".into(), sels.into());
    Value::Object(o)
}

fn parse_variable(n: Node) -> Value {
    let mut o = Obj::new();
    o.insert("guid".into(), guid_attr(n, "guid").into());
    o.insert("name".into(), attr(n, "name").unwrap_or_default().into());
    o.insert(
        "typeOfVariable".into(),
        attr(n, "typeOfVariable")
            .unwrap_or_else(|| "Text".into())
            .into(),
    );
    set_opt(&mut o, "description", child_text(n, "Description"));
    Value::Object(o)
}

fn parse_variable_value(n: Node) -> Value {
    let mut o = Obj::new();
    let var = child(n, "VariableRef")
        .map(|r| guid_attr(r, "targetGUID"))
        .unwrap_or_default();
    o.insert("variableGuid".into(), var.into());
    if let Some(t) = child_text(n, "TextValue") {
        o.insert("textValue".into(), t.into());
    } else if let Some(b) = child_text(n, "BooleanValue") {
        o.insert("booleanValue".into(), (b == "true").into());
    } else if let Some(i) = child_text(n, "IntegerValue") {
        o.insert("integerValue".into(), js_number(&i));
    } else if let Some(f) = child_text(n, "FloatValue") {
        o.insert("floatValue".into(), js_number(&f));
    }
    Value::Object(o)
}

/// JS `Number(str)`: the whole (trimmed) string must be numeric; empty is 0.
fn js_number(s: &str) -> Value {
    let t = s.trim();
    if t.is_empty() {
        return Value::from(0);
    }
    t.parse::<f64>().map(num).unwrap_or(Value::Null)
}

fn parse_case(n: Node) -> Value {
    json!({
        "guid": guid_attr(n, "guid"),
        "name": attr(n, "name").unwrap_or_default(),
        "sourceRefGuids": children(n, "SourceRef").map(|r| guid_attr(r, "targetGUID")).collect::<Vec<_>>(),
        "values": children(n, "VariableValue").map(parse_variable_value).collect::<Vec<_>>(),
    })
}

fn opt_guid_attr(n: Node, name: &str) -> Option<String> {
    attr(n, name)
        .filter(|s| !s.is_empty())
        .map(|s| normalize_guid(Some(&s)))
}

fn parse_vertex(n: Node) -> Value {
    let f = |k: &str| js_parse_float(attr(n, k).as_deref()).filter(|v| v.is_finite());
    let mut o = Obj::new();
    o.insert("guid".into(), guid_attr(n, "guid").into());
    set_opt(
        &mut o,
        "representedGuid",
        opt_guid_attr(n, "representedGUID"),
    );
    set_opt(&mut o, "name", attr(n, "name"));
    o.insert("firstX".into(), num(f("firstX").unwrap_or(0.0)));
    o.insert("firstY".into(), num(f("firstY").unwrap_or(0.0)));
    set_opt(&mut o, "secondX", f("secondX").map(num));
    set_opt(&mut o, "secondY", f("secondY").map(num));
    set_opt(&mut o, "shape", attr(n, "shape"));
    set_opt(&mut o, "color", attr(n, "color"));
    Value::Object(o)
}

fn parse_edge(n: Node) -> Value {
    let mut o = Obj::new();
    o.insert("guid".into(), guid_attr(n, "guid").into());
    set_opt(
        &mut o,
        "representedGuid",
        opt_guid_attr(n, "representedGUID"),
    );
    set_opt(&mut o, "name", attr(n, "name"));
    o.insert("sourceVertex".into(), guid_attr(n, "sourceVertex").into());
    o.insert("targetVertex".into(), guid_attr(n, "targetVertex").into());
    set_opt(&mut o, "color", attr(n, "color"));
    set_opt(&mut o, "direction", attr(n, "direction"));
    set_opt(&mut o, "lineStyle", attr(n, "lineStyle"));
    Value::Object(o)
}

fn parse_graph(n: Node) -> Value {
    let mut o = Obj::new();
    o.insert("guid".into(), guid_attr(n, "guid").into());
    set_opt(&mut o, "name", attr(n, "name"));
    o.insert(
        "vertices".into(),
        children(n, "Vertex")
            .map(parse_vertex)
            .collect::<Vec<_>>()
            .into(),
    );
    o.insert(
        "edges".into(),
        children(n, "Edge")
            .map(parse_edge)
            .collect::<Vec<_>>()
            .into(),
    );
    Value::Object(o)
}

fn parse_link(n: Node) -> Value {
    let mut o = Obj::new();
    o.insert("guid".into(), guid_attr(n, "guid").into());
    set_opt(&mut o, "name", attr(n, "name"));
    set_opt(&mut o, "direction", attr(n, "direction"));
    set_opt(&mut o, "color", attr(n, "color"));
    set_opt(&mut o, "originGuid", opt_guid_attr(n, "originGUID"));
    set_opt(&mut o, "targetGuid", opt_guid_attr(n, "targetGUID"));
    Value::Object(o)
}

/// Where each `<Note>` is anchored, from `<NoteRef>`s: on a source → a
/// document memo; inside a text selection → a content memo at that span.
fn scan_note_refs(src: Node, anchors: &mut Map<String, Value>) {
    let source_guid = guid_attr(src, "guid");
    for nr in children(src, "NoteRef") {
        anchors.insert(
            guid_attr(nr, "targetGUID"),
            json!({ "sourceGuid": source_guid }),
        );
    }
    let mut scan = |parent: Node| {
        for sel in children(parent, "PlainTextSelection") {
            for nr in children(sel, "NoteRef") {
                anchors.insert(
                    guid_attr(nr, "targetGUID"),
                    json!({
                        "sourceGuid": source_guid,
                        "startPosition": js_parse_int(attr(sel, "startPosition").as_deref()).unwrap_or(0),
                        "endPosition": js_parse_int(attr(sel, "endPosition").as_deref()).unwrap_or(0),
                    }),
                );
            }
        }
    };
    scan(src);
    for repr in children(src, "Representation") {
        scan(repr);
    }
}

pub fn deserialize_project(xml: &str) -> Result<Value, String> {
    let xml = crate::xml_read::repair_if_needed(xml);
    let doc = crate::xml_read::parse(&xml).map_err(|e| format!("Invalid project XML: {e}"))?;
    let proj = doc.root_element();
    if proj.tag_name().name() != "Project" {
        return Err("Invalid project XML: root element is not <Project>".into());
    }

    let users: Vec<Value> = list(proj, &["Users", "User"])
        .into_iter()
        .map(|u| {
            let mut o = Obj::new();
            o.insert("guid".into(), guid_attr(u, "guid").into());
            set_opt(&mut o, "name", attr(u, "name"));
            set_opt(&mut o, "id", attr(u, "id"));
            Value::Object(o)
        })
        .collect();

    let codes: Vec<Value> = list(proj, &["CodeBook", "Codes", "Code"])
        .into_iter()
        .map(parse_code)
        .collect();

    let sources_el = child(proj, "Sources");
    let src_list = |name: &'static str| -> Vec<Node> {
        sources_el
            .map(|s| children(s, name).collect())
            .unwrap_or_default()
    };
    let mut sources: Vec<Value> = Vec::new();
    sources.extend(src_list("TextSource").into_iter().map(parse_text_source));
    sources.extend(src_list("PDFSource").into_iter().map(parse_pdf_source));
    sources.extend(
        src_list("PictureSource")
            .into_iter()
            .map(parse_picture_source),
    );
    sources.extend(src_list("VideoSource").into_iter().map(parse_video_source));
    sources.extend(src_list("AudioSource").into_iter().map(parse_audio_source));

    let sets: Vec<Value> = list(proj, &["Sets", "Set"])
        .into_iter()
        .map(|s| {
            let mut o = Obj::new();
            o.insert("guid".into(), guid_attr(s, "guid").into());
            o.insert("name".into(), attr(s, "name").unwrap_or_default().into());
            set_opt(&mut o, "description", child_text(s, "Description"));
            o.insert(
                "memberSourceGuids".into(),
                children(s, "MemberSource")
                    .map(|m| guid_attr(m, "targetGUID"))
                    .collect::<Vec<_>>()
                    .into(),
            );
            o.insert(
                "memberCodeGuids".into(),
                children(s, "MemberCode")
                    .map(|m| guid_attr(m, "targetGUID"))
                    .collect::<Vec<_>>()
                    .into(),
            );
            Value::Object(o)
        })
        .collect();

    let refi_variables: Vec<Value> = list(proj, &["Variables", "Variable"])
        .into_iter()
        .map(parse_variable)
        .collect();
    let refi_cases: Vec<Value> = list(proj, &["Cases", "Case"])
        .into_iter()
        .map(parse_case)
        .collect();
    let refi_graphs: Vec<Value> = list(proj, &["Graphs", "Graph"])
        .into_iter()
        .map(parse_graph)
        .collect();
    let refi_links: Vec<Value> = list(proj, &["Links", "Link"])
        .into_iter()
        .map(parse_link)
        .collect();
    let refi_notes: Vec<Value> = list(proj, &["Notes", "Note"])
        .into_iter()
        .map(|n| {
            let mut o = Obj::new();
            o.insert("guid".into(), guid_attr(n, "guid").into());
            o.insert(
                "name".into(),
                attr(n, "name").unwrap_or_else(|| "Memo".into()).into(),
            );
            set_opt(&mut o, "plainTextPath", attr(n, "plainTextPath"));
            set_opt(&mut o, "creationDateTime", attr(n, "creationDateTime"));
            set_opt(&mut o, "modifiedDateTime", attr(n, "modifiedDateTime"));
            Value::Object(o)
        })
        .collect();

    let mut anchors = Map::new();
    for name in [
        "TextSource",
        "PDFSource",
        "PictureSource",
        "AudioSource",
        "VideoSource",
    ] {
        for s in src_list(name) {
            scan_note_refs(s, &mut anchors);
        }
    }

    let mut o = Obj::new();
    o.insert(
        "name".into(),
        attr(proj, "name")
            .unwrap_or_else(|| "Untitled".into())
            .into(),
    );
    o.insert(
        "origin".into(),
        attr(proj, "origin").unwrap_or_default().into(),
    );
    set_opt(&mut o, "description", child_text(proj, "Description"));
    o.insert(
        "creatingUserGUID".into(),
        guid_attr(proj, "creatingUserGUID").into(),
    );
    set_opt(&mut o, "creationDateTime", attr(proj, "creationDateTime"));
    o.insert(
        "modifyingUserGUID".into(),
        guid_attr(proj, "modifyingUserGUID").into(),
    );
    set_opt(&mut o, "modifiedDateTime", attr(proj, "modifiedDateTime"));
    o.insert("users".into(), users.into());
    o.insert("codes".into(), codes.into());
    o.insert("sources".into(), sources.into());
    o.insert("sets".into(), sets.into());
    o.insert("notes".into(), json!([]));
    fn transient(o: &mut Obj, k: &str, v: Vec<Value>) {
        if !v.is_empty() {
            o.insert(k.into(), v.into());
        }
    }
    transient(&mut o, "_refiVariables", refi_variables);
    transient(&mut o, "_refiCases", refi_cases);
    transient(&mut o, "_refiNotes", refi_notes);
    if !anchors.is_empty() {
        o.insert("_refiNoteAnchors".into(), Value::Object(anchors));
    }
    transient(&mut o, "_refiGraphs", refi_graphs);
    transient(&mut o, "_refiLinks", refi_links);
    Ok(Value::Object(o))
}
