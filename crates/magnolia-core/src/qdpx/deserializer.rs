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
    // Its description, which the reader makes a memo on it.
    set_opt(&mut o, "_description", child_text(n, "Description").filter(|d| !d.trim().is_empty()));
    // Codings of the whole document, which the reader puts on a passage
    // (or area) covering all of it.
    let whole: Vec<Value> = children(n, "Coding").map(parse_coding).collect();
    if !whole.is_empty() {
        o.insert("_documentCodings".into(), whole.into());
    }
    // A document's own variable values (as MAXQDA writes its document
    // variables); the reader turns them into tags.
    let values: Vec<Value> = children(n, "VariableValue").map(parse_variable_value).collect();
    if !values.is_empty() {
        o.insert("_refiVariableValues".into(), values.into());
    }
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
    set_opt(&mut o, "description", child_text(n, "Description"));
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
    set_opt(&mut o, "description", child_text(n, "Description"));
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
            set_opt(&mut o, "description", child_text(ts, "Description"));
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
    // Coded stretches of the recording: an <AudioSelection> has the same
    // begin / end (ms) as a <VideoSelection>, and the reader turns both into
    // time-range selections.
    let raw: Vec<Value> = children(n, "AudioSelection")
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
    // The text representation's description and whole-document codings
    // are the PDF's.
    if let Some(r) = repr {
        if let Some(d) = child_text(r, "Description").filter(|d| !d.trim().is_empty()) {
            let both = match o.get("_description").and_then(Value::as_str) {
                Some(first) if first.trim() != d.trim() => format!("{first}\n\n{d}"),
                Some(first) => first.to_string(),
                None => d,
            };
            o.insert("_description".into(), both.into());
        }
        let whole: Vec<Value> = children(r, "Coding").map(parse_coding).collect();
        if !whole.is_empty() {
            let mut all = o.get("_documentCodings").and_then(Value::as_array).cloned().unwrap_or_default();
            all.extend(whole);
            o.insert("_documentCodings".into(), all.into());
        }
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
        // xs:boolean: "true"/"false" or "1"/"0".
        let b = b.trim();
        o.insert("booleanValue".into(), (b == "true" || b == "1").into());
    } else if let Some(i) = child_text(n, "IntegerValue") {
        o.insert("integerValue".into(), js_number(&i));
    } else if let Some(f) = child_text(n, "FloatValue") {
        o.insert("floatValue".into(), js_number(&f));
    } else if let Some(d) = child_text(n, "DateValue") {
        o.insert("dateValue".into(), d.trim().into());
    } else if let Some(d) = child_text(n, "DateTimeValue") {
        o.insert("dateTimeValue".into(), d.trim().into());
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
        "description": child_text(n, "Description"),
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
    // On an area of a PDF or picture, or a passage of a transcript: the
    // reader attaches it once that area or passage is in place.
    let mut on_selection = |sel: Node| {
        for nr in children(sel, "NoteRef") {
            anchors.insert(
                guid_attr(nr, "targetGUID"),
                json!({ "sourceGuid": source_guid, "selectionGuid": guid_attr(sel, "guid") }),
            );
        }
    };
    for sel in children(src, "PDFSelection").chain(children(src, "PictureSelection")) {
        on_selection(sel);
    }
    for t in children(src, "Transcript") {
        for sel in children(t, "TranscriptSelection") {
            on_selection(sel);
        }
    }
}

const SOURCES: [&str; 5] = ["TextSource", "PDFSource", "PictureSource", "AudioSource", "VideoSource"];

/// What a file holds that Magnolia can't keep, by kind: how many of each.
/// Opening the file is fine, but saving it over the original leaves these
/// out, so the app tells the user (and suggests Save As). Only things
/// Magnolia never writes itself are counted, so its own projects report
/// nothing.
pub fn not_kept(proj: Node) -> Map<String, Value> {
    let name = |n: Node| n.tag_name().name().to_string();
    let parent = |n: Node| n.parent_element().map(name).unwrap_or_default();
    let within = |n: Node, tag: &str| n.ancestors().skip(1).any(|a| a.is_element() && a.tag_name().name() == tag);
    let edge_links: std::collections::HashSet<String> = proj
        .descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "Edge")
        .filter_map(|e| attr(e, "representedGUID").map(|g| normalize_guid(Some(&g))))
        .collect();
    let mut counts: std::collections::BTreeMap<&str, u64> = Default::default();
    for n in proj.descendants().filter(Node::is_element) {
        let kind = match n.tag_name().name() {
            // Links between items, except those a map's arrows stand for.
            "Link" if !attr(n, "guid").is_some_and(|g| edge_links.contains(&normalize_guid(Some(&g)))) => Some("links"),
            // A coding of a whole recording with no transcript to put it on
            // (a whole document's is kept as a passage covering all of it).
            "Coding"
                if ["AudioSource", "VideoSource"].contains(&parent(n).as_str())
                    && n.parent_element().is_some_and(|m| child(m, "Transcript").is_none()) =>
            {
                Some("documentCodings")
            }
            // Codings inside memos.
            "Coding" if within(n, "Note") => Some("memoCodings"),
            // Text attached to a picture, or to an area of a PDF (if there's
            // any: text, a text file, or coding in it).
            "TextDescription" | "Representation"
                if (name(n) == "TextDescription" || parent(n) == "PDFSelection")
                    && (child_text(n, "PlainTextContent").is_some_and(|t| !t.trim().is_empty())
                        || attr(n, "plainTextPath").is_some_and(|p| !p.is_empty())
                        || child(n, "PlainTextSelection").is_some()
                        || child(n, "Coding").is_some()) =>
            {
                Some("attachedTexts")
            }
            // A memo attached where Magnolia can't attach one: to a code, a
            // coding, a link, a memo or a stretch of a recording. (On a
            // document, a passage of its text or transcript, or an area of a
            // PDF or picture, it is kept.)
            "NoteRef" => {
                let p = parent(n);
                let on_document = SOURCES.contains(&p.as_str())
                    || (["PDFSelection", "PictureSelection", "TranscriptSelection"].contains(&p.as_str())
                        && !within(n, "Note"));
                let on_passage = p == "PlainTextSelection"
                    && n.parent_element().and_then(|s| s.parent_element()).is_some_and(|d| {
                        let t = name(d);
                        t == "TextSource" || (t == "Representation" && d.parent_element().is_some_and(|x| name(x) == "PDFSource"))
                    });
                let on_project = p == "Project";
                (!on_document && !on_passage && !on_project && !within(n, "Note")).then_some("memoAttachments")
            }
            // Descriptions of transcripts, memos and variables (Magnolia's
            // own survey variables excepted); a document's becomes a memo.
            "Description" if n.text().is_some_and(|t| !t.trim().is_empty()) => {
                let p = parent(n);
                let in_attached_text = p == "Representation" && n.parent_element().and_then(|r| r.parent_element()).is_some_and(|x| name(x) == "PDFSelection");
                let own_variable = p == "Variable" && n.text().is_some_and(|t| t.trim_start().starts_with("magnolia:v1:"));
                let of_document = SOURCES.contains(&p.as_str())
                    || (p == "Representation" && n.parent_element().and_then(|r| r.parent_element()).is_some_and(|x| name(x) == "PDFSource"));
                (!of_document && (["Transcript", "Note", "Representation"].contains(&p.as_str()) || p == "Variable")
                    && !own_variable
                    && !in_attached_text)
                    .then_some("descriptions")
            }
            // A case's links to codes and to passages.
            "CodeRef" | "SelectionRef" if parent(n) == "Case" => Some("caseLinks"),
            // Memos in sets.
            "MemberNote" => Some("setMemos"),
            // A recording's transcripts after the first.
            "Transcript" if n.prev_sibling_element().is_some_and(|p| name(p) == "Transcript") => Some("extraTranscripts"),
            _ => None,
        };
        if let Some(k) = kind {
            *counts.entry(k).or_default() += 1;
        }
    }
    counts.into_iter().map(|(k, v)| (k.to_string(), v.into())).collect()
}

pub fn deserialize_project(xml: &str) -> Result<Value, String> {
    let xml = crate::xml_read::repair_if_needed(xml);
    let doc = crate::xml_read::parse(&xml).map_err(|e| {
        crate::message::tr(
            "invalidProjectXml",
            "Invalid project XML: {{detail}}",
            &[("detail", &e.to_string())],
        )
    })?;
    let proj = doc.root_element();
    if proj.tag_name().name() != "Project" {
        return Err(crate::message::tr(
            "notAProject",
            "Invalid project XML: root element is not <Project>",
            &[],
        ));
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
            // A note's text may also be inline (the schema allows either).
            set_opt(&mut o, "plainTextContent", child_text(n, "PlainTextContent"));
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
    let left_out = not_kept(proj);
    if !left_out.is_empty() {
        o.insert("notKept".into(), Value::Object(left_out));
    }
    Ok(Value::Object(o))
}
