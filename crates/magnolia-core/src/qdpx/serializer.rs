//! Magnolia project JSON → REFI-QDA project XML (.qde).
//!
//! Child-element order follows the QDA-XML 1.0 schema sequences exactly —
//! Atlas.ti rejects a whole file over a single out-of-order child — so the
//! comments below call out each ordering constraint.

use super::graph_refi::collect_graphs;
use super::survey_refi::survey_to_refi;
use super::transcript_refi::is_transcript_coding;
use crate::util::{
    get_arr, get_f64, get_nonempty, get_str, has, js_num_to_string, js_round, js_to_string, truthy,
};
use crate::xml_build::{El, document, uppercase_guids};
use serde_json::Value;
use std::collections::HashMap;

fn round_str(v: f64) -> String {
    js_num_to_string(js_round(v))
}

fn serialize_code(code: &Value) -> El {
    let mut el = El::new("Code")
        .attr("guid", get_str(code, "guid").unwrap_or(""))
        .attr("name", get_str(code, "name").unwrap_or(""));
    // isCodable is required on every Code; default true when absent.
    let codable = code
        .get("isCodable")
        .filter(|v| !v.is_null())
        .map(js_to_string)
        .unwrap_or_else(|| "true".into());
    el.set("isCodable", codable);
    el.set_opt("color", get_nonempty(code, "color"));
    if let Some(d) = get_nonempty(code, "description") {
        el.push(El::text("Description", d));
    }
    for c in get_arr(code, "children") {
        el.push(serialize_code(c));
    }
    el
}

pub fn codes_xml(codes: &[Value]) -> Vec<El> {
    codes.iter().map(serialize_code).collect()
}

fn serialize_coding(c: &Value) -> El {
    El::new("Coding")
        .attr("guid", get_str(c, "guid").unwrap_or(""))
        .attr_maybe("creatingUser", c.get("creatingUser"))
        .attr_maybe("creationDateTime", c.get("creationDateTime"))
        .child(El::new("CodeRef").attr("targetGUID", get_str(c, "codeGuid").unwrap_or("")))
}

trait AttrMaybe {
    fn attr_maybe(self, key: &str, v: Option<&Value>) -> Self;
}

impl AttrMaybe for El {
    /// fast-xml-parser dropped `undefined` attributes but stringified any
    /// other value; mirror that for attributes the TS set unconditionally.
    fn attr_maybe(self, key: &str, v: Option<&Value>) -> Self {
        match v {
            None => self,
            Some(Value::Null) => self.attr(key, "null"),
            Some(v) => self.attr(key, js_to_string(v)),
        }
    }
}

fn audit(el: &mut El, v: &Value) {
    for k in [
        "creatingUser",
        "creationDateTime",
        "modifyingUser",
        "modifiedDateTime",
    ] {
        el.set_opt(k, get_nonempty(v, k));
    }
}

fn push_codings(el: &mut El, sel: &Value) {
    for c in get_arr(sel, "codings") {
        el.push(serialize_coding(c));
    }
}

fn serialize_selection(sel: &Value) -> El {
    let mut el = El::new("PlainTextSelection")
        .attr("guid", get_str(sel, "guid").unwrap_or(""))
        .attr(
            "startPosition",
            js_to_string(sel.get("startPosition").unwrap_or(&Value::Null)),
        )
        .attr(
            "endPosition",
            js_to_string(sel.get("endPosition").unwrap_or(&Value::Null)),
        );
    el.set_opt("name", get_nonempty(sel, "name"));
    audit(&mut el, sel);
    if let Some(d) = get_nonempty(sel, "description") {
        el.push(El::text("Description", d));
    }
    push_codings(&mut el, sel);
    el
}

/// Resolve the real audio extension: explicit `audioExt`, the source name's
/// extension, the audio handle's extension, else `"audio"`.
pub fn audio_extension_for(s: &Value) -> String {
    let fd = s.get("formatData");
    if let Some(e) = fd.and_then(|f| get_nonempty(f, "audioExt")) {
        return e.to_lowercase();
    }
    let ext_re = regex::Regex::new(r"(?i)\.([a-z0-9]+)$").unwrap();
    let from = |s: &str| {
        ext_re
            .captures(s)
            .map(|c| c[1].to_lowercase())
            .filter(|e| e != "audio")
    };
    if let Some(e) = from(
        &get_str(s, "name")
            .map(str::to_string)
            .unwrap_or_else(|| s.get("name").map(js_to_string).unwrap_or_default()),
    ) {
        return e;
    }
    if let Some(e) = fd.and_then(|f| get_str(f, "audioFilePath")).and_then(from) {
        return e;
    }
    "audio".into()
}

fn serialize_text_source(s: &Value) -> El {
    let mut el = El::new("TextSource").attr("guid", get_str(s, "guid").unwrap_or(""));
    el.set_opt("name", get_nonempty(s, "name"));
    el.set_opt("plainTextPath", get_nonempty(s, "plainTextPath"));
    el.set_opt("richTextPath", get_nonempty(s, "richTextPath"));
    audit(&mut el, s);
    if let Some(c) = get_nonempty(s, "plainTextContent") {
        el.push(El::text("PlainTextContent", c));
    }
    // Survey-cell selections are cell-relative, meaningless against this
    // source's text; they round-trip via the side table instead.
    for sel in get_arr(s, "selections")
        .iter()
        .filter(|sel| !has(sel, "surveyCell"))
    {
        el.push(serialize_selection(sel));
    }
    el
}

fn region_rect(sel: &Value) -> Option<(f64, f64, f64, f64, &Value)> {
    let r = sel.get("pdfRegion").filter(|r| truthy(r))?;
    let f = |k: &str| get_f64(r, k).unwrap_or(f64::NAN);
    Some((f("x"), f("y"), f("width"), f("height"), r))
}

/// `<PictureSelection>` — pixel coordinates are xs:integer, so rounded.
fn serialize_picture_selection(sel: &Value) -> Option<El> {
    let (x, y, w, h, _) = region_rect(sel)?;
    let mut el = El::new("PictureSelection")
        .attr("guid", get_str(sel, "guid").unwrap_or(""))
        .attr("firstX", round_str(x))
        .attr("firstY", round_str(y))
        .attr("secondX", round_str(x + w))
        .attr("secondY", round_str(y + h));
    el.set_opt("name", get_nonempty(sel, "name"));
    audit(&mut el, sel);
    if let Some(d) = get_nonempty(sel, "description") {
        el.push(El::text("Description", d));
    }
    push_codings(&mut el, sel);
    Some(el)
}

/// Only a pure timeline coding becomes a `<VideoSelection>`; transcript-text
/// codings ride solely in their `<TranscriptSelection>` (emitting both makes
/// Atlas drop the code from the transcript text on round-trip).
fn serialize_video_selection(sel: &Value) -> Option<El> {
    let tr = sel.get("timeRange").filter(|t| truthy(t))?;
    if is_transcript_coding(sel) {
        return None;
    }
    let ms = |k: &str| round_str(get_f64(tr, k).unwrap_or(f64::NAN) * 1000.0);
    let mut el = El::new("VideoSelection")
        .attr("guid", get_str(sel, "guid").unwrap_or(""))
        .attr("begin", ms("startTime"))
        .attr("end", ms("endTime"));
    el.set_opt("name", get_nonempty(sel, "name"));
    audit(&mut el, sel);
    if let Some(d) = get_nonempty(sel, "description") {
        el.push(El::text("Description", d));
    }
    push_codings(&mut el, sel);
    Some(el)
}

fn serialize_transcript_selection(ts: &Value) -> El {
    let mut el = El::new("TranscriptSelection").attr("guid", get_str(ts, "guid").unwrap_or(""));
    el.set_opt("name", get_nonempty(ts, "name"));
    el.set_opt("fromSyncPoint", get_nonempty(ts, "fromSyncPoint"));
    el.set_opt("toSyncPoint", get_nonempty(ts, "toSyncPoint"));
    el.set_opt("creatingUser", get_nonempty(ts, "creatingUser"));
    el.set_opt("creationDateTime", get_nonempty(ts, "creationDateTime"));
    push_codings(&mut el, ts);
    el
}

/// `<Transcript>`: SyncPoint* MUST precede TranscriptSelection*.
fn serialize_transcript(t: &Value) -> El {
    let mut el = El::new("Transcript")
        .attr("guid", get_str(t, "guid").unwrap_or(""))
        .attr("plainTextPath", get_str(t, "plainTextPath").unwrap_or(""));
    for sp in get_arr(t, "syncPoints") {
        let mut s = El::new("SyncPoint").attr("guid", get_str(sp, "guid").unwrap_or(""));
        s.set_opt("timeStamp", get_f64(sp, "timeStamp").map(round_str));
        s.set_opt("position", get_f64(sp, "position").map(round_str));
        el.push(s);
    }
    for ts in get_arr(t, "selections") {
        el.push(serialize_transcript_selection(ts));
    }
    el
}

fn media_base(tag: &str, s: &Value, path: String) -> El {
    let mut el = El::new(tag)
        .attr("guid", get_str(s, "guid").unwrap_or(""))
        .attr("path", path);
    el.set_opt("name", get_nonempty(s, "name"));
    audit(&mut el, s);
    el
}

fn video_ext(s: &Value) -> String {
    s.get("formatData")
        .and_then(|f| get_nonempty(f, "videoExt"))
        .unwrap_or("mp4")
        .to_string()
}

/// `<VideoSource>`: Transcript MUST precede VideoSelection.
fn serialize_video_source(s: &Value) -> El {
    let guid = get_str(s, "guid").unwrap_or("");
    let mut el = media_base(
        "VideoSource",
        s,
        format!("internal://{guid}.{}", video_ext(s)),
    );
    if let Some(t) = s.get("_refiTranscript").filter(|t| truthy(t)) {
        el.push(serialize_transcript(t));
    }
    for v in get_arr(s, "selections")
        .iter()
        .filter_map(serialize_video_selection)
    {
        el.push(v);
    }
    el
}

fn serialize_audio_source(s: &Value) -> El {
    let guid = get_str(s, "guid").unwrap_or("");
    let mut el = media_base(
        "AudioSource",
        s,
        format!("internal://{guid}.{}", audio_extension_for(s)),
    );
    if let Some(t) = s.get("_refiTranscript").filter(|t| truthy(t)) {
        el.push(serialize_transcript(t));
    }
    el
}

const SPLIT_TEXT_SOURCE_NODE: &str = "D0C0DE000001";
const SPLIT_MEDIA_TRANSCRIPT_NODE: &str = "D0C0DE000002";

fn split_source_guid(g: &str, node: &str) -> String {
    let prefix: String = if g.chars().count() >= 24 {
        g.chars().take(24).collect()
    } else {
        g.to_string()
    };
    format!("{prefix}{node}")
}

/// Serialize a coded media transcript the way Atlas.ti does — as three
/// sources (media; a transcript `<TextSource>` carrying the codings; a second
/// media source with the SyncPoints) — or `None` when it has no transcript
/// codings. Atlas only honours codings on a real TextSource's selections.
fn split_coded_media_transcript(s: &Value, video: bool) -> Option<(El, El, El)> {
    let transcript = s.get("_refiTranscript").filter(|t| truthy(t))?;
    let codings: Vec<&Value> = get_arr(s, "selections")
        .iter()
        .filter(|x| is_transcript_coding(x))
        .collect();
    if codings.is_empty() {
        return None;
    }
    let guid = get_str(s, "guid").unwrap_or("");
    let ext = if video {
        video_ext(s)
    } else {
        audio_extension_for(s)
    };
    let media_path = format!("internal://{guid}.{ext}");
    let text_path = format!("internal://{guid}.txt");

    let mut media_clone = s.clone();
    media_clone
        .as_object_mut()
        .unwrap()
        .remove("_refiTranscript");
    media_clone["selections"] = get_arr(s, "selections")
        .iter()
        .filter(|x| !is_transcript_coding(x))
        .cloned()
        .collect::<Vec<_>>()
        .into();
    let media = if video {
        serialize_video_source(&media_clone)
    } else {
        serialize_audio_source(&media_clone)
    };

    let mut text = El::new("TextSource")
        .attr("guid", split_source_guid(guid, SPLIT_TEXT_SOURCE_NODE))
        .attr("name", "Transcript")
        .attr("plainTextPath", text_path.clone());
    for c in &codings {
        text.push(serialize_selection(c));
    }

    let sync_only = serde_json::json!({
        "guid": transcript.get("guid"),
        "plainTextPath": text_path,
        "syncPoints": transcript.get("syncPoints"),
        "selections": [],
    });
    let transcript_source = El::new(if video { "VideoSource" } else { "AudioSource" })
        .attr("guid", split_source_guid(guid, SPLIT_MEDIA_TRANSCRIPT_NODE))
        .attr("name", "Transcript")
        .attr("path", media_path)
        .child(serialize_transcript(&sync_only));
    Some((media, text, transcript_source))
}

/// Distinct-but-stable Representation guid (first nibble flipped). Atlas.ti's
/// validator rejects a Representation reusing its source's guid.
pub fn representation_guid_for(source_guid: &str) -> String {
    crate::util::flip_first_nibble(source_guid, false)
}

/// A PDF box coding as `<PDFSelection>`: Magnolia stores top-left origin with
/// 1-based pages; other tools expect PDF-native bottom-left with 0-based
/// pages, so flip Y by the page height when known.
fn serialize_pdf_selection(sel: &Value, page_sizes: Option<&Vec<Value>>) -> Option<El> {
    let (x, y, w, h, r) = region_rect(sel)?;
    let page_num = r
        .get("page")
        .filter(|p| !p.is_null())
        .and_then(Value::as_f64)
        .unwrap_or(1.0);
    let page = (page_num - 1.0).max(0.0);
    let height = page_sizes
        .and_then(|ps| ps.get(page_num as usize))
        .and_then(|p| get_f64(p, "height"))
        .filter(|h| *h > 0.0);
    let (first_y, second_y) = match height {
        Some(ph) => (js_round(ph - (y + h)), js_round(ph - y)),
        None => (js_round(y), js_round(y + h)),
    };
    let mut el = El::new("PDFSelection")
        .attr("guid", get_str(sel, "guid").unwrap_or(""))
        .attr("page", js_num_to_string(page))
        .attr("firstX", round_str(x))
        .attr("firstY", js_num_to_string(first_y))
        .attr("secondX", round_str(x + w))
        .attr("secondY", js_num_to_string(second_y));
    el.set_opt("name", get_nonempty(sel, "name"));
    audit(&mut el, sel);
    push_codings(&mut el, sel);
    Some(el)
}

/// `<PDFSource>`: box codings become `<PDFSelection>`s (which MUST precede
/// the Representation); text codings live inside the `<Representation>`,
/// whose distinct guid names the extracted-text file.
fn serialize_pdf_source(s: &Value) -> El {
    let guid = get_str(s, "guid").unwrap_or("");
    let mut el = media_base("PDFSource", s, format!("internal://{guid}.pdf"));
    let repr_guid = representation_guid_for(guid);
    let mut repr = El::new("Representation")
        .attr("guid", repr_guid.clone())
        .attr("plainTextPath", format!("internal://{repr_guid}.txt"));
    if let Some(n) = get_nonempty(s, "name") {
        repr.set("name", format!("Representation_for_{n}"));
    }
    audit(&mut repr, s);
    let page_sizes = s
        .get("formatData")
        .and_then(|f| f.get("pdfPageSizes"))
        .and_then(Value::as_array);
    for sel in get_arr(s, "selections") {
        if has(sel, "pdfRegion")
            && let Some(p) = serialize_pdf_selection(sel, page_sizes)
        {
            el.push(p);
        }
    }
    for sel in get_arr(s, "selections")
        .iter()
        .filter(|sel| !has(sel, "pdfRegion"))
    {
        repr.push(serialize_selection(sel));
    }
    el.push(repr);
    el
}

fn serialize_image_source(s: &Value) -> El {
    let guid = get_str(s, "guid").unwrap_or("");
    let ext = s
        .get("formatData")
        .and_then(|f| get_nonempty(f, "imageExt"))
        .unwrap_or("png");
    let mut el = media_base("PictureSource", s, format!("internal://{guid}.{ext}"));
    for p in get_arr(s, "selections")
        .iter()
        .filter_map(serialize_picture_selection)
    {
        el.push(p);
    }
    el
}

fn serialize_variable(v: &Value) -> El {
    let mut el = El::new("Variable")
        .attr("guid", get_str(v, "guid").unwrap_or(""))
        .attr("name", get_str(v, "name").unwrap_or(""))
        .attr("typeOfVariable", get_str(v, "typeOfVariable").unwrap_or(""));
    if let Some(d) = get_nonempty(v, "description") {
        el.push(El::text("Description", d));
    }
    el
}

/// `<Case>`: VariableValue* MUST precede SourceRef*.
fn serialize_case(c: &Value) -> El {
    let mut el = El::new("Case")
        .attr("guid", get_str(c, "guid").unwrap_or(""))
        .attr("name", get_str(c, "name").unwrap_or(""));
    for val in get_arr(c, "values") {
        let mut vv = El::new("VariableValue").child(
            El::new("VariableRef").attr("targetGUID", get_str(val, "variableGuid").unwrap_or("")),
        );
        let present = |k: &str| val.get(k).filter(|v| !v.is_null());
        if let Some(t) = present("textValue") {
            vv.push(El::text("TextValue", js_to_string(t)));
        } else if let Some(b) = present("booleanValue") {
            vv.push(El::text(
                "BooleanValue",
                if truthy(b) { "true" } else { "false" },
            ));
        } else if let Some(i) = present("integerValue") {
            vv.push(El::text("IntegerValue", js_to_string(i)));
        } else if let Some(f) = present("floatValue") {
            vv.push(El::text("FloatValue", js_to_string(f)));
        }
        el.push(vv);
    }
    for g in get_arr(c, "sourceRefGuids") {
        el.push(El::new("SourceRef").attr("targetGUID", g.as_str().unwrap_or("")));
    }
    el
}

fn serialize_respondent_doc(d: &Value) -> El {
    let mut el = El::new("TextSource").attr("guid", get_str(d, "guid").unwrap_or(""));
    el.set_opt("name", get_nonempty(d, "name"));
    if let Some(t) = get_nonempty(d, "text") {
        el.push(El::text("PlainTextContent", t));
    }
    for sel in get_arr(d, "selections") {
        let mut s = El::new("PlainTextSelection")
            .attr("guid", get_str(sel, "guid").unwrap_or(""))
            .attr("startPosition", js_to_string(&sel["startPosition"]))
            .attr("endPosition", js_to_string(&sel["endPosition"]));
        push_codings(&mut s, sel);
        el.push(s);
    }
    el
}

fn serialize_vertex(v: &Value) -> El {
    let f = |k: &str| get_f64(v, k).unwrap_or(f64::NAN);
    let mut el = El::new("Vertex")
        .attr("guid", get_str(v, "guid").unwrap_or(""))
        .attr("firstX", round_str(f("firstX")))
        .attr("firstY", round_str(f("firstY")));
    el.set_opt("representedGUID", get_nonempty(v, "representedGuid"));
    el.set_opt("name", get_nonempty(v, "name"));
    el.set_opt(
        "secondX",
        v.get("secondX")
            .filter(|x| !x.is_null())
            .map(|_| round_str(f("secondX"))),
    );
    el.set_opt(
        "secondY",
        v.get("secondY")
            .filter(|x| !x.is_null())
            .map(|_| round_str(f("secondY"))),
    );
    el.set_opt("shape", get_nonempty(v, "shape"));
    el.set_opt("color", get_nonempty(v, "color"));
    el
}

fn serialize_edge(e: &Value) -> El {
    let mut el = El::new("Edge")
        .attr("guid", get_str(e, "guid").unwrap_or(""))
        .attr("sourceVertex", get_str(e, "sourceVertex").unwrap_or(""))
        .attr("targetVertex", get_str(e, "targetVertex").unwrap_or(""));
    for (k, attr) in [
        ("representedGuid", "representedGUID"),
        ("name", "name"),
        ("color", "color"),
        ("direction", "direction"),
        ("lineStyle", "lineStyle"),
    ] {
        el.set_opt(attr, get_nonempty(e, k));
    }
    el
}

fn serialize_link(l: &Value) -> El {
    let mut el = El::new("Link").attr("guid", get_str(l, "guid").unwrap_or(""));
    for (k, attr) in [
        ("name", "name"),
        ("direction", "direction"),
        ("color", "color"),
        ("originGuid", "originGUID"),
        ("targetGuid", "targetGUID"),
    ] {
        el.set_opt(attr, get_nonempty(l, k));
    }
    el
}

/// `<Graph>`: Vertex* MUST precede Edge*.
fn serialize_graph(g: &Value) -> El {
    let mut el = El::new("Graph").attr("guid", get_str(g, "guid").unwrap_or(""));
    el.set_opt("name", get_nonempty(g, "name"));
    for v in get_arr(g, "vertices") {
        el.push(serialize_vertex(v));
    }
    for e in get_arr(g, "edges") {
        el.push(serialize_edge(e));
    }
    el
}

pub fn serialize_project(project: &Value, app_version: &str) -> String {
    let mut p = El::new("Project")
        .attr("xmlns", "urn:QDA-XML:project:1.0")
        .attr("xmlns:xsi", "http://www.w3.org/2001/XMLSchema-instance")
        .attr("xsi:schemaLocation", "urn:QDA-XML:project:1.0 http://schema.qdasoftware.org/versions/Project/v1.0/Project.xsd")
        .attr("name", project.get("name").map(js_to_string).unwrap_or_default())
        .attr("origin", get_nonempty(project, "origin").map(str::to_string).unwrap_or_else(|| format!("Magnolia {app_version}")));
    for k in [
        "creatingUserGUID",
        "creationDateTime",
        "modifyingUserGUID",
        "modifiedDateTime",
    ] {
        p.set_opt(k, get_nonempty(project, k));
    }

    // Element sequence: Users, CodeBook, Variables, Cases, Sources, Notes,
    // Links, Sets, Graphs, Description.
    let users = get_arr(project, "users");
    if !users.is_empty() {
        let mut el = El::new("Users");
        for u in users {
            let mut ue = El::new("User").attr("guid", get_str(u, "guid").unwrap_or(""));
            ue.set_opt("name", get_nonempty(u, "name"));
            ue.set_opt("id", get_nonempty(u, "id"));
            el.push(ue);
        }
        p.push(el);
    }

    let codes = get_arr(project, "codes");
    if !codes.is_empty() {
        let mut c = El::new("Codes");
        c.children = codes_xml(codes);
        p.push(El::new("CodeBook").child(c));
    }

    let mut variables = Vec::new();
    let mut cases = Vec::new();
    let mut respondent_docs = Vec::new();
    let mut respondent_doc_guid: HashMap<String, String> = HashMap::new();
    for s in get_arr(project, "sources") {
        if get_str(s, "sourceType") != Some("survey") {
            continue;
        }
        let Some(survey) = s
            .get("formatData")
            .and_then(|f| f.get("survey"))
            .filter(|v| truthy(v))
        else {
            continue;
        };
        let refi = survey_to_refi(
            survey,
            get_str(s, "guid").unwrap_or(""),
            get_arr(s, "selections"),
        );
        variables.extend(refi.variables);
        cases.extend(refi.cases);
        for d in &refi.respondent_docs {
            respondent_doc_guid.insert(
                format!(
                    "{} {}",
                    get_str(d, "sourceGuid").unwrap_or(""),
                    get_str(d, "respondentId").unwrap_or("")
                ),
                get_str(d, "guid").unwrap_or("").to_string(),
            );
        }
        respondent_docs.extend(refi.respondent_docs);
    }
    if !variables.is_empty() {
        p.push(El {
            name: "Variables".into(),
            children: variables.iter().map(serialize_variable).collect(),
            ..Default::default()
        });
    }
    if !cases.is_empty() {
        p.push(El {
            name: "Cases".into(),
            children: cases.iter().map(serialize_case).collect(),
            ..Default::default()
        });
    }

    let sources = get_arr(project, "sources");
    if !sources.is_empty() {
        let of_type = |t: &'static str| {
            sources
                .iter()
                .filter(move |s| get_str(s, "sourceType") == Some(t))
        };
        let mut split_text_sources = Vec::new();
        let mut audio_xml = Vec::new();
        for s in of_type("audio") {
            match split_coded_media_transcript(s, false) {
                Some((media, text, transcript)) => {
                    audio_xml.push(media);
                    audio_xml.push(transcript);
                    split_text_sources.push(text);
                }
                None => audio_xml.push(serialize_audio_source(s)),
            }
        }
        let mut video_xml = Vec::new();
        for s in of_type("video") {
            match split_coded_media_transcript(s, true) {
                Some((media, text, transcript)) => {
                    video_xml.push(media);
                    video_xml.push(transcript);
                    split_text_sources.push(text);
                }
                None => video_xml.push(serialize_video_source(s)),
            }
        }
        let mut src_el = El::new("Sources");
        let is_special = |s: &Value| {
            matches!(
                get_str(s, "sourceType"),
                Some("pdf" | "audio" | "image" | "video")
            )
        };
        src_el.children.extend(
            sources
                .iter()
                .filter(|s| !is_special(s))
                .map(serialize_text_source),
        );
        src_el
            .children
            .extend(respondent_docs.iter().map(serialize_respondent_doc));
        src_el.children.extend(split_text_sources);
        src_el
            .children
            .extend(of_type("pdf").map(serialize_pdf_source));
        src_el.children.extend(audio_xml);
        src_el
            .children
            .extend(of_type("image").map(serialize_image_source));
        src_el.children.extend(video_xml);
        p.push(src_el);
    }

    // Memos are free project-level <Note>s (no NoteRef), matching Atlas.ti's
    // own export; anchors round-trip via magnolia-memos.json. Relationship
    // maps add synthetic notes backing their free-text boxes.
    let graph_bundle = collect_graphs(get_arr(project, "savedAnalyses"));
    let creating_user = get_nonempty(project, "creatingUserGUID");
    let mut notes = El::new("Notes");
    for m in get_arr(project, "memos") {
        let guid = get_str(m, "guid").unwrap_or("");
        let mut n = El::new("Note")
            .attr("guid", guid)
            .attr("name", get_nonempty(m, "title").unwrap_or("Memo"))
            .attr("plainTextPath", format!("internal://{guid}.txt"));
        n.set_opt("creatingUser", creating_user);
        n.set_opt("creationDateTime", get_nonempty(m, "createdDateTime"));
        n.set_opt("modifyingUser", creating_user);
        n.set_opt(
            "modifiedDateTime",
            get_nonempty(m, "modifiedDateTime").or_else(|| get_nonempty(m, "createdDateTime")),
        );
        notes.push(n);
    }
    for n in &graph_bundle.notes {
        let mut ne = El::new("Note")
            .attr("guid", get_str(n, "guid").unwrap_or(""))
            .attr("name", get_str(n, "name").unwrap_or(""));
        if let Some(c) = get_nonempty(n, "content") {
            ne.push(El::text("PlainTextContent", c));
        }
        notes.push(ne);
    }
    if !notes.children.is_empty() {
        p.push(notes);
    }

    if !graph_bundle.links.is_empty() {
        p.push(El {
            name: "Links".into(),
            children: graph_bundle.links.iter().map(serialize_link).collect(),
            ..Default::default()
        });
    }

    let sets = get_arr(project, "sets");
    if !sets.is_empty() {
        let mut sets_el = El::new("Sets");
        for s in sets {
            let mut se = El::new("Set")
                .attr("guid", get_str(s, "guid").unwrap_or(""))
                .attr("name", get_str(s, "name").unwrap_or(""));
            if let Some(d) = get_nonempty(s, "description") {
                se.push(El::text("Description", d));
            }
            // SetType sequence: Description?, MemberCode*, MemberSource*.
            for g in get_arr(s, "memberCodeGuids") {
                se.push(El::new("MemberCode").attr("targetGUID", js_to_string(g)));
            }
            // A respondent tag maps to a MemberSource on that respondent's
            // exported document (REFI Sets have no MemberCase).
            let respondent_docs = get_arr(s, "memberSurveyRespondents")
                .iter()
                .filter_map(|m| {
                    respondent_doc_guid
                        .get(&format!(
                            "{} {}",
                            get_str(m, "sourceGuid").unwrap_or(""),
                            get_str(m, "id").unwrap_or("")
                        ))
                        .cloned()
                });
            let members: Vec<String> = get_arr(s, "memberSourceGuids")
                .iter()
                .map(js_to_string)
                .chain(respondent_docs)
                .collect();
            for g in members {
                se.push(El::new("MemberSource").attr("targetGUID", g));
            }
            sets_el.push(se);
        }
        p.push(sets_el);
    }

    if !graph_bundle.graphs.is_empty() {
        p.push(El {
            name: "Graphs".into(),
            children: graph_bundle.graphs.iter().map(serialize_graph).collect(),
            ..Default::default()
        });
    }

    if let Some(d) = get_nonempty(project, "description") {
        p.push(El::text("Description", d));
    }

    let xml = document(
        &[
            ("version", "1.0"),
            ("encoding", "utf-8"),
            ("standalone", "yes"),
        ],
        &p,
    );
    uppercase_guids(
        &xml,
        "guid|targetGUID|representedGUID|sourceVertex|targetVertex|creatingUser(?:GUID)?|modifyingUser(?:GUID)?",
    )
}
