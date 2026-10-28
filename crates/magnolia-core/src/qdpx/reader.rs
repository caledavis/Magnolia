//! .qdpx → project JSON + source contents.
//!
//! Mirrors the TypeScript `readQdpx` step for step: parse the .qde, attach
//! each source's text / media handle, restore Magnolia's JSON side tables,
//! then reconcile the standards-native representations (transcripts, media
//! split by Atlas.ti, surveys as Variables/Cases, maps as Graphs) for files
//! that arrived without those side tables.
//!
//! One step is finished in the renderer: PDFs that need their text extracted
//! (foreign files and fresh imports) are flagged `_pendingPdfText`, because
//! Magnolia's character offsets are defined by pdf.js — see `pdf_info`.

use super::archive::Archive;
use super::deserializer::deserialize_project;
use super::graph_refi::{GraphEntity, graph_to_map};
use super::survey_refi::refi_to_survey;
use super::transcript_refi::{
    MediaTranscriptPaths, derive_line_time_range, line_start_offsets_with_end,
    reconcile_media_transcripts, reconstruct_line_times, reconstruct_transcript_selections,
    transcript_twin_guid_for,
};
use crate::binary_store::{archive_handle, archive_handle_for_file};
use crate::util::{
    Obj, ext_of, get_arr, get_f64, get_nonempty, get_str, has, internal_name, new_guid, num, truthy,
};
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};
use std::path::Path;

/// Progress reporter: (stage, current, total); total 0 = indeterminate.
pub type Progress<'a> = &'a dyn Fn(&str, usize, usize);

fn mime(ext: &str, table: &[(&str, &str)], fallback: &str) -> String {
    table
        .iter()
        .find(|(e, _)| *e == ext)
        .map(|(_, m)| *m)
        .unwrap_or(fallback)
        .to_string()
}
const IMAGE_MIME: &[(&str, &str)] = &[
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("png", "image/png"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
];
const VIDEO_MIME: &[(&str, &str)] = &[
    ("mp4", "video/mp4"),
    ("mov", "video/quicktime"),
    ("avi", "video/x-msvideo"),
];
const AUDIO_MIME: &[(&str, &str)] = &[
    ("mp3", "audio/mpeg"),
    ("m4a", "audio/mp4"),
    ("aac", "audio/aac"),
    ("wav", "audio/wav"),
    ("ogg", "audio/ogg"),
    ("flac", "audio/flac"),
];

/// Copy the common selection fields from a raw (rect / time) selection.
fn selection_from_raw(raw: &Value) -> Obj {
    let mut o = Obj::new();
    o.insert(
        "guid".into(),
        raw.get("guid").cloned().unwrap_or(Value::Null),
    );
    {
        let k = "name";
        if let Some(v) = raw.get(k) {
            o.insert(k.into(), v.clone());
        }
    }
    o.insert("startPosition".into(), 0.into());
    o.insert("endPosition".into(), 0.into());
    o
}

fn finish_selection(mut o: Obj, raw: &Value) -> Value {
    for k in [
        "creatingUser",
        "creationDateTime",
        "modifyingUser",
        "modifiedDateTime",
    ] {
        if let Some(v) = raw.get(k) {
            o.insert(k.into(), v.clone());
        }
    }
    o.insert(
        "codings".into(),
        raw.get("codings").cloned().unwrap_or(json!([])),
    );
    Value::Object(o)
}

/// `<VideoSelection>` (ms) → time-range selection (seconds).
fn convert_video_selection(raw: &Value) -> Value {
    let mut o = selection_from_raw(raw);
    let f = |k: &str| get_f64(raw, k).unwrap_or(f64::NAN);
    o.insert(
        "timeRange".into(),
        json!({ "startTime": num(f("begin") / 1000.0), "endTime": num(f("end") / 1000.0) }),
    );
    finish_selection(o, raw)
}

fn raw_rect(raw: &Value) -> (f64, f64, f64, f64) {
    let f = |k: &str| get_f64(raw, k).unwrap_or(f64::NAN);
    (f("firstX"), f("firstY"), f("secondX"), f("secondY"))
}

/// `<PictureSelection>` (pixels, top-left) → region selection on page 1.
fn convert_picture_selection(raw: &Value) -> Value {
    let (fx, fy, sx, sy) = raw_rect(raw);
    let mut o = selection_from_raw(raw);
    o.insert(
        "pdfRegion".into(),
        json!({ "page": 1, "x": num(fx.min(sx)), "y": num(fy.min(sy)), "width": num((sx - fx).abs()), "height": num((sy - fy).abs()) }),
    );
    finish_selection(o, raw)
}

/// Per-origin quirks for `<PDFSelection>` coordinates. The spec says points
/// with a top-left origin; MAXQDA and Atlas.ti write PDF-native bottom-left
/// coordinates with 0-based pages.
struct PdfQuirks {
    page_base: i64,
    unit_scale: f64,
    y_flip: bool,
}

fn pdf_quirks(origin: &str) -> PdfQuirks {
    let o = origin.to_lowercase();
    if o.starts_with("maxqda") || o.starts_with("atlas") {
        PdfQuirks {
            page_base: 1,
            unit_scale: 1.0,
            y_flip: true,
        }
    } else {
        PdfQuirks {
            page_base: 0,
            unit_scale: 1.0,
            y_flip: false,
        }
    }
}

/// A standalone `<PDFSelection>` is a box coding and stays one.
fn convert_pdf_selection(raw: &Value, q: &PdfQuirks, page_sizes: &[Value]) -> Value {
    let page = raw
        .get("page")
        .and_then(Value::as_i64)
        .map(|p| p + q.page_base);
    let (fx, fy, sx, sy) = raw_rect(raw);
    let s = q.unit_scale;
    let x = fx.min(sx) * s;
    let width = (sx - fx).abs() * s;
    let height = (sy - fy).abs() * s;
    let page_height = page
        .and_then(|p| usize::try_from(p).ok())
        .and_then(|p| page_sizes.get(p))
        .and_then(|p| get_f64(p, "height"));
    let y = match (q.y_flip, page_height) {
        (true, Some(ph)) => ph - fy.max(sy) * s,
        _ => fy.min(sy) * s,
    };
    let mut o = selection_from_raw(raw);
    o.insert(
        "pdfRegion".into(),
        json!({ "page": page.map(Value::from).unwrap_or(Value::Null), "x": num(x), "y": num(y), "width": num(width), "height": num(height) }),
    );
    finish_selection(o, raw)
}

fn take(o: &mut Value, key: &str) -> Option<Value> {
    o.as_object_mut().and_then(|m| m.remove(key))
}

fn json_entry(a: &mut Archive, name: &str) -> Option<Value> {
    a.read(name).and_then(|b| serde_json::from_slice(&b).ok())
}

pub fn read_qdpx(path: &Path, progress: Option<Progress>) -> Result<Value, String> {
    let report = |s: &str, c: usize, t: usize| {
        if let Some(p) = progress {
            p(s, c, t)
        }
    };
    report("Reading file", 0, 0);
    let mut zip = Archive::open(path).map_err(|e| format!("Could not open project: {e}"))?;
    report("Unpacking archive", 0, 0);
    let sources_dir = zip.sources_dir();
    let qde = zip
        .qde_name()
        .ok_or("Invalid QDPX file: missing project.qde")?;
    report("Parsing project", 0, 0);
    let xml = zip
        .read_utf8(&qde)
        .ok_or("Invalid QDPX file: unreadable project.qde")?;
    let mut project = deserialize_project(&xml)?;
    let in_sources = |name: &str| format!("{sources_dir}/{name}");

    // Capture per-source references before the loop below clears paths.
    let mut binary_ref_by_guid: HashMap<String, String> = HashMap::new();
    let mut paths = MediaTranscriptPaths::default();
    for s in get_arr(&project, "sources") {
        let guid = get_str(s, "guid").unwrap_or("").to_string();
        let st = get_str(s, "sourceType").unwrap_or("");
        let ptp = get_str(s, "plainTextPath");
        if ["pdf", "image", "audio", "video"].contains(&st)
            && let Some(m) = internal_name(ptp)
        {
            binary_ref_by_guid.insert(guid.clone(), m.to_string());
        }
        if st == "audio" || st == "video" {
            if let Some(p) = get_nonempty(s, "plainTextPath") {
                paths.media_path_by_guid.insert(guid.clone(), p.to_string());
            }
            let tp = s
                .get("_refiTranscript")
                .and_then(|t| get_str(t, "plainTextPath"));
            if let Some(m) = internal_name(tp) {
                paths
                    .transcript_file_by_guid
                    .insert(guid.clone(), m.to_string());
            }
        } else if (st.is_empty() || st == "text")
            && let Some(m) = internal_name(ptp)
        {
            paths.text_file_by_guid.insert(guid, m.to_string());
        }
    }

    let origin = get_str(&project, "origin").unwrap_or("").to_string();
    let mut source_contents = Map::new();
    let mut sources: Vec<Value> = take(&mut project, "sources")
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default();
    let total = sources.len();
    for (done, source) in sources.iter_mut().enumerate() {
        load_source(
            source,
            &mut zip,
            &sources_dir,
            &origin,
            &mut source_contents,
        );
        report("Loading documents", done + 1, total);
    }
    project["sources"] = sources.into();

    restore_side_tables(&mut project, &mut zip, &sources_dir, &mut source_contents);

    // ── Transcript reconciliation (foreign <Transcript>s → lineTimes) ──
    let mut sources: Vec<Value> = take(&mut project, "sources")
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default();
    for source in sources.iter_mut() {
        let Some(transcript) = take(source, "_refiTranscript") else {
            continue;
        };
        let guid = get_str(source, "guid").unwrap_or("").to_string();
        if !source_contents.get(&guid).is_some_and(truthy)
            && let Some(m) = internal_name(get_str(&transcript, "plainTextPath"))
            && m != format!("{guid}.txt")
            && let Some(t) = zip.read_text(&in_sources(m))
        {
            source_contents.insert(guid.clone(), t.into());
        }
        let has_line_times = source
            .get("formatData")
            .and_then(|f| f.get("lineTimes"))
            .and_then(Value::as_object)
            .is_some_and(|m| !m.is_empty());
        let sync_points = get_arr(&transcript, "syncPoints");
        if !has_line_times && !sync_points.is_empty() {
            let text = source_contents
                .get(&guid)
                .and_then(Value::as_str)
                .unwrap_or("");
            let rebuilt = reconstruct_line_times(text, sync_points);
            if !rebuilt.is_empty() {
                let fd = source
                    .as_object_mut()
                    .unwrap()
                    .entry("formatData")
                    .or_insert(json!({}));
                if !fd.is_object() {
                    *fd = json!({});
                }
                fd["lineTimes"] = Value::Object(rebuilt);
            }
        }
        if !get_arr(&transcript, "selections").is_empty() {
            let mut have = HashSet::new();
            for s in get_arr(source, "selections") {
                let g = get_str(s, "guid").unwrap_or("");
                have.insert(g.to_string());
                have.insert(transcript_twin_guid_for(g));
            }
            let rebuilt: Vec<Value> = reconstruct_transcript_selections(&transcript)
                .into_iter()
                .filter(|s| !have.contains(get_str(s, "guid").unwrap_or("")))
                .collect();
            if !rebuilt.is_empty() {
                let mut sels = get_arr(source, "selections").to_vec();
                sels.extend(rebuilt);
                source["selections"] = sels.into();
            }
        }
    }

    // ── Media-transcript reconciliation (Atlas's three-source layout) ──
    let mut sources = reconcile_media_transcripts(sources, &mut source_contents, &paths);

    // ── Re-derive video coding timeRanges from line times ──
    for source in sources.iter_mut() {
        if get_str(source, "sourceType") != Some("video") {
            continue;
        }
        let Some(lt) = source
            .get("formatData")
            .and_then(|f| f.get("lineTimes"))
            .filter(|v| v.as_object().is_some_and(|m| !m.is_empty()))
            .cloned()
        else {
            continue;
        };
        let guid = get_str(source, "guid").unwrap_or("").to_string();
        let text = source_contents
            .get(&guid)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if let Some(sels) = source.get_mut("selections").and_then(Value::as_array_mut) {
            for sel in sels.iter_mut() {
                if has(sel, "timeRange") || has(sel, "pdfRegion") || has(sel, "surveyCell") {
                    continue;
                }
                let (Some(s), Some(e)) =
                    (get_f64(sel, "startPosition"), get_f64(sel, "endPosition"))
                else {
                    continue;
                };
                if e <= s {
                    continue;
                }
                if let Some(tr) = derive_line_time_range(&text, s, e, Some(&lt)) {
                    sel["timeRange"] = tr;
                }
            }
        }
    }

    // ── Survey REFI reconciliation ──
    let refi_variables = take(&mut project, "_refiVariables")
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default();
    let refi_cases = take(&mut project, "_refiCases")
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default();
    if !refi_cases.is_empty() {
        reconcile_survey(
            &mut project,
            &mut sources,
            &mut source_contents,
            &refi_variables,
            &refi_cases,
        );
    }

    // ── Missing binaries ──
    let missing: Vec<Value> = sources
        .iter()
        .filter(|s| {
            let st = get_str(s, "sourceType").unwrap_or("");
            if !["pdf", "image", "audio", "video"].contains(&st) {
                return false;
            }
            let guid = get_str(s, "guid").unwrap_or("");
            if let Some(r) = binary_ref_by_guid.get(guid)
                && zip.has(&in_sources(r))
            {
                return false;
            }
            let prefix = in_sources(&format!("{guid}."));
            !zip.names().iter().any(|n| n.starts_with(&prefix) && !n.to_lowercase().ends_with(".txt"))
        })
        .map(|s| json!({ "guid": s.get("guid"), "name": s.get("name"), "sourceType": s.get("sourceType") }))
        .collect();

    project["sources"] = sources.into();
    for k in [
        "_refiNotes",
        "_refiNoteAnchors",
        "_refiGraphs",
        "_refiLinks",
    ] {
        take(&mut project, k);
    }
    project["sourceContents"] = Value::Object(source_contents);
    project["missingBinaries"] = missing.into();
    Ok(project)
}

/// Pass 1: attach one source's text / media handle from the archive.
fn load_source(
    source: &mut Value,
    zip: &mut Archive,
    sources_dir: &str,
    origin: &str,
    contents: &mut Map<String, Value>,
) {
    let guid = get_str(source, "guid").unwrap_or("").to_string();
    let st = get_str(source, "sourceType").unwrap_or("").to_string();
    let in_sources = |name: &str| format!("{sources_dir}/{name}");
    let internal = internal_name(get_str(source, "plainTextPath")).map(str::to_string);
    let has_path = has(source, "plainTextPath");
    let obj = source.as_object_mut().unwrap();

    match st.as_str() {
        "audio" => {
            // Foreign imports carry the binary only via plainTextPath; advertise
            // the archive handle so it plays. Magnolia's side table later
            // overwrites this with richer recorded metadata.
            if let Some(name) = internal.as_ref().filter(|n| zip.has(&in_sources(n))) {
                let ext = Some(ext_of(name))
                    .filter(|e| !e.is_empty())
                    .unwrap_or_else(|| "m4a".into());
                let raw = obj
                    .get("_rawVideoSelections")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                if !raw.is_empty() {
                    obj.insert(
                        "selections".into(),
                        raw.iter()
                            .map(convert_video_selection)
                            .collect::<Vec<_>>()
                            .into(),
                    );
                }
                obj.insert(
                    "formatData".into(),
                    json!({
                        "audioFilePath": archive_handle_for_file(name),
                        "mimeType": mime(&ext, AUDIO_MIME, "audio/mpeg"),
                        "audioExt": ext,
                        "duration": 0,
                    }),
                );
            }
            obj.remove("_rawVideoSelections");
            let text = zip
                .read_text(&in_sources(&format!("{guid}.txt")))
                .unwrap_or_default();
            contents.insert(guid, text.into());
            obj.remove("plainTextPath");
        }
        "pdf" if has_path => {
            if let Some(name) = internal.as_ref()
                && let Some(bytes) = zip.read(&in_sources(name))
            {
                // Box sizes now; text is extracted in the renderer with pdf.js.
                let page_sizes = crate::pdf_info::page_sizes(&bytes).unwrap_or_default();
                let raw = obj
                    .get("_rawPdfSelections")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                if !raw.is_empty() {
                    let q = pdf_quirks(origin);
                    let existing: HashSet<String> =
                        get_arr(&Value::Object(obj.clone()), "selections")
                            .iter()
                            .filter_map(|s| get_str(s, "guid").map(str::to_string))
                            .collect();
                    let mut sels = obj
                        .get("selections")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    sels.extend(
                        raw.iter()
                            .filter(|r| !existing.contains(get_str(r, "guid").unwrap_or("")))
                            .map(|r| convert_pdf_selection(r, &q, &page_sizes)),
                    );
                    obj.insert("selections".into(), sels.into());
                }
                obj.insert(
                    "formatData".into(),
                    json!({ "pdfFilePath": archive_handle_for_file(name), "pdfPageOffsets": [], "pdfPageSizes": page_sizes }),
                );
                obj.insert("_pendingPdfText".into(), true.into());
                contents.insert(guid.clone(), "".into());
            }
            obj.remove("plainTextPath");
            obj.remove("_rawPdfSelections");
            contents.entry(guid).or_insert("".into());
        }
        "video" if has_path => {
            if let Some(name) = internal.as_ref().filter(|n| zip.has(&in_sources(n))) {
                let ext = Some(ext_of(name))
                    .filter(|e| !e.is_empty())
                    .unwrap_or_else(|| "mp4".into());
                let raw = obj
                    .get("_rawVideoSelections")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                if !raw.is_empty() {
                    obj.insert(
                        "selections".into(),
                        raw.iter()
                            .map(convert_video_selection)
                            .collect::<Vec<_>>()
                            .into(),
                    );
                }
                obj.insert(
                    "formatData".into(),
                    json!({
                        "videoFilePath": archive_handle_for_file(name),
                        "mimeType": mime(&ext, VIDEO_MIME, "video/mp4"),
                        "duration": 0,
                        "videoExt": ext,
                    }),
                );
            }
            obj.remove("plainTextPath");
            obj.remove("_rawVideoSelections");
            if !contents.contains_key(&guid) {
                let t = zip
                    .read_text(&in_sources(&format!("{guid}.txt")))
                    .unwrap_or_default();
                contents.insert(guid, t.into());
            }
        }
        "image" if has_path => {
            if let Some(name) = internal.as_ref().filter(|n| zip.has(&in_sources(n))) {
                let ext = Some(ext_of(name))
                    .filter(|e| !e.is_empty())
                    .unwrap_or_else(|| "png".into());
                let raw = obj
                    .get("_rawPictureSelections")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                if !raw.is_empty() {
                    obj.insert(
                        "selections".into(),
                        raw.iter()
                            .map(convert_picture_selection)
                            .collect::<Vec<_>>()
                            .into(),
                    );
                }
                obj.insert(
                    "formatData".into(),
                    json!({
                        "imageFilePath": archive_handle_for_file(name),
                        "mimeType": mime(&ext, IMAGE_MIME, "application/octet-stream"),
                        "imageExt": ext,
                    }),
                );
            }
            obj.remove("plainTextPath");
            obj.remove("_rawPictureSelections");
            contents.insert(guid, "".into());
        }
        _ => {
            if has_path {
                if let Some(t) = internal.and_then(|name| zip.read_text(&in_sources(&name))) {
                    contents.insert(guid, t.into());
                }
            } else if let Some(c) = obj.get("plainTextContent").filter(|v| truthy(v)) {
                contents.insert(guid, c.clone());
            }
        }
    }
}

/// Restore Magnolia's JSON side tables (queries, logbook, tags, memos,
/// quotes, folders, analyses, tabs, hotkeys, source metadata).
fn restore_side_tables(
    project: &mut Value,
    zip: &mut Archive,
    sources_dir: &str,
    contents: &mut Map<String, Value>,
) {
    let in_sources = |name: &str| format!("{sources_dir}/{name}");
    if let Some(v) = json_entry(zip, "magnolia-queries.json") {
        project["savedQueries"] = v;
    }
    if let Some(v) = json_entry(zip, "magnolia-logbook.json") {
        project["logbookEntries"] = v;
    }
    if let Some(ext) = json_entry(zip, "magnolia-tags.json") {
        if let Some(c) = ext.get("categories").filter(|v| truthy(v)) {
            project["tagCategories"] = c.clone();
        }
        if let (Some(meta), Some(sets)) = (
            ext.get("tagMeta").and_then(Value::as_array),
            project.get_mut("sets").and_then(Value::as_array_mut),
        ) {
            for m in meta {
                let Some(set) = sets.iter_mut().find(|s| s.get("guid") == m.get("guid")) else {
                    continue;
                };
                let so = set.as_object_mut().unwrap();
                for k in ["categoryGuid", "value"] {
                    match m.get(k) {
                        Some(v) => so.insert(k.into(), v.clone()),
                        None => so.remove(k),
                    };
                }
                for k in ["memberSurveyRespondents", "memberSurveyQuestions"] {
                    if let Some(v) = m.get(k).filter(|v| truthy(v)) {
                        so.insert(k.into(), v.clone());
                    }
                }
            }
        }
    }

    // Memos: Magnolia's side table, else build them from REFI <Note>s.
    if let Some(v) = json_entry(zip, "magnolia-memos.json") {
        project["memos"] = v;
    } else if let Some(notes) = project.get("_refiNotes").and_then(Value::as_array).cloned() {
        let anchors = project
            .get("_refiNoteAnchors")
            .cloned()
            .unwrap_or(json!({}));
        // Notes backing a map's free-text boxes aren't real memos.
        let mut free_text: HashSet<String> = HashSet::new();
        for g in get_arr(project, "_refiGraphs") {
            for v in get_arr(g, "vertices") {
                if get_str(v, "shape") == Some("Note")
                    && let Some(r) = get_nonempty(v, "representedGuid")
                {
                    free_text.insert(r.to_string());
                }
            }
        }
        let mut built = Vec::new();
        for n in &notes {
            let guid = get_str(n, "guid").unwrap_or("");
            if free_text.contains(guid) {
                continue;
            }
            let content = internal_name(get_str(n, "plainTextPath"))
                .and_then(|m| zip.read_text(&in_sources(m)))
                .unwrap_or_default();
            let created = get_nonempty(n, "creationDateTime")
                .or_else(|| get_nonempty(n, "modifiedDateTime"))
                .unwrap_or("");
            let mut m = Obj::new();
            m.insert("guid".into(), guid.into());
            m.insert("type".into(), "project".into());
            m.insert(
                "title".into(),
                n.get("name").cloned().unwrap_or(Value::Null),
            );
            m.insert("content".into(), content.into());
            m.insert("createdDateTime".into(), created.into());
            if let Some(md) = n.get("modifiedDateTime") {
                m.insert("modifiedDateTime".into(), md.clone());
            }
            if let Some(a) = anchors.get(guid) {
                let sg = a.get("sourceGuid").cloned().unwrap_or(Value::Null);
                if a.get("startPosition").is_some() {
                    m.insert("type".into(), "content".into());
                    m.insert("sourceGuid".into(), sg);
                    m.insert("startPosition".into(), a["startPosition"].clone());
                    m.insert(
                        "endPosition".into(),
                        a.get("endPosition").cloned().unwrap_or(Value::Null),
                    );
                } else {
                    m.insert("type".into(), "document".into());
                    m.insert("sourceGuids".into(), json!([sg]));
                }
            }
            built.push(Value::Object(m));
        }
        if !built.is_empty() {
            project["memos"] = built.into();
        }
    }

    if let Some(v) = json_entry(zip, "magnolia-quotes.json") {
        project["quotes"] = v;
    }
    if let Some(ext) = json_entry(zip, "magnolia-folders.json") {
        if let Some(f) = ext.get("folders").filter(|v| v.is_array()) {
            project["folders"] = f.clone();
        }
        if let Some(sf) = ext.get("sourceFolder").filter(|v| v.is_object()) {
            project["sourceFolder"] = sf.clone();
        }
    }
    if let Some(v) = json_entry(zip, "magnolia-analyses.json") {
        project["savedAnalyses"] = v;
    }

    // Rebuild maps from <Graph>s that have no side-table analysis.
    let graphs = get_arr(project, "_refiGraphs").to_vec();
    if !graphs.is_empty() {
        let existing: HashSet<String> = get_arr(project, "savedAnalyses")
            .iter()
            .filter_map(|a| get_str(a, "guid").map(str::to_string))
            .collect();
        let mut codes: HashMap<String, (String, Option<String>)> = HashMap::new();
        fn walk(codes: &[Value], out: &mut HashMap<String, (String, Option<String>)>) {
            for c in codes {
                out.insert(
                    get_str(c, "guid").unwrap_or("").into(),
                    (
                        get_str(c, "name").unwrap_or("").into(),
                        get_str(c, "color").map(str::to_string),
                    ),
                );
                walk(get_arr(c, "children"), out);
            }
        }
        walk(get_arr(project, "codes"), &mut codes);
        let by_guid = |key: &str| -> HashMap<String, Value> {
            get_arr(project, key)
                .iter()
                .filter_map(|s| get_str(s, "guid").map(|g| (g.to_string(), s.clone())))
                .collect()
        };
        let (sources, sets, memos) = (by_guid("sources"), by_guid("sets"), by_guid("memos"));
        let resolve = |g: &str| -> Option<GraphEntity> {
            if let Some((name, color)) = codes.get(g) {
                return Some(GraphEntity {
                    kind: "code",
                    label: name.clone(),
                    code_color: color.clone(),
                    source_type: None,
                });
            }
            if let Some(s) = sources.get(g) {
                let label = get_str(s, "name").unwrap_or("").into();
                return Some(GraphEntity {
                    kind: "document",
                    label,
                    code_color: None,
                    source_type: get_str(s, "sourceType").map(str::to_string),
                });
            }
            if let Some(t) = sets.get(g) {
                return Some(GraphEntity {
                    kind: "tag",
                    label: get_str(t, "name").unwrap_or("").into(),
                    code_color: None,
                    source_type: None,
                });
            }
            memos.get(g).map(|m| GraphEntity {
                kind: "memo",
                label: get_str(m, "title").unwrap_or("").into(),
                code_color: None,
                source_type: None,
            })
        };
        let links: HashMap<String, Value> = get_arr(project, "_refiLinks")
            .iter()
            .filter_map(|l| get_str(l, "guid").map(|g| (g.to_string(), l.clone())))
            .collect();
        let rebuilt: Vec<Value> = graphs
            .iter()
            .filter(|g| !existing.contains(get_str(g, "guid").unwrap_or("")))
            .map(|g| graph_to_map(g, &resolve, &links))
            .collect();
        if !rebuilt.is_empty() {
            let mut all = get_arr(project, "savedAnalyses").to_vec();
            all.extend(rebuilt);
            project["savedAnalyses"] = all.into();
        }
    }

    if let Some(v) = json_entry(zip, "magnolia-tabs.json") {
        project["tabState"] = v;
    }

    if let Some(ext) = json_entry(zip, "magnolia-codes.json")
        && let Some(hotkeys) = ext.get("hotkeys").and_then(Value::as_array)
    {
        fn apply(codes: &mut [Value], hotkeys: &[Value]) {
            for c in codes {
                if let Some(h) = hotkeys.iter().find(|h| h.get("guid") == c.get("guid")) {
                    c["hotkey"] = h.get("hotkey").cloned().unwrap_or(Value::Null);
                }
                if let Some(ch) = c.get_mut("children").and_then(Value::as_array_mut) {
                    apply(ch, hotkeys);
                }
            }
        }
        if let Some(codes) = project.get_mut("codes").and_then(Value::as_array_mut) {
            apply(codes, hotkeys);
        }
    }

    if let Some(ext) = json_entry(zip, "magnolia-sources.json")
        && let Some(meta) = ext.get("sourceMeta").and_then(Value::as_array)
    {
        for meta in meta {
            let guid = get_str(meta, "guid").unwrap_or("").to_string();
            let text = contents
                .get(&guid)
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let Some(sources) = project.get_mut("sources").and_then(Value::as_array_mut) else {
                break;
            };
            let Some(source) = sources
                .iter_mut()
                .find(|s| get_str(s, "guid") == Some(&guid))
            else {
                continue;
            };
            apply_source_meta(source, meta, zip, sources_dir, &text);
        }
    }
}

fn apply_source_meta(
    source: &mut Value,
    meta: &Value,
    zip: &mut Archive,
    sources_dir: &str,
    text: &str,
) {
    let in_sources = |name: &str| format!("{sources_dir}/{name}");
    let guid = get_str(meta, "guid").unwrap_or("").to_string();
    if let Some(st) = meta.get("sourceType").filter(|v| truthy(v)) {
        source["sourceType"] = st.clone();
    }
    if source.get("selections").and_then(Value::as_array).is_none() {
        source["selections"] = json!([]);
    }

    // Side-table regions are authoritative: they stay 0–0 box codings.
    if let Some(regions) = meta.get("pdfRegionSelections").and_then(Value::as_array) {
        let by_guid: HashMap<&str, &Value> = regions
            .iter()
            .filter_map(|r| {
                get_str(r, "guid").map(|g| (g, r.get("region").unwrap_or(&Value::Null)))
            })
            .collect();
        for sel in source["selections"].as_array_mut().unwrap() {
            if let Some(region) = get_str(sel, "guid")
                .and_then(|g| by_guid.get(g))
                .filter(|r| truthy(r))
            {
                sel["pdfRegion"] = (*region).clone();
                sel["startPosition"] = 0.into();
                sel["endPosition"] = 0.into();
            }
        }
    }
    if let Some(cells) = meta.get("surveyCellSelections").and_then(Value::as_array) {
        source["selections"]
            .as_array_mut()
            .unwrap()
            .extend(cells.iter().cloned());
    }
    // Video codings' char anchors (legacy files stored whole lines).
    if let Some(anchors) = meta.get("videoSelectionAnchors").and_then(Value::as_array) {
        let line_offsets = line_start_offsets_with_end(text);
        for sel in source["selections"].as_array_mut().unwrap() {
            let Some(a) = anchors.iter().find(|a| a.get("guid") == sel.get("guid")) else {
                continue;
            };
            if let Some(sc) = a.get("startChar").filter(|v| !v.is_null()) {
                sel["startPosition"] = sc.clone();
                sel["endPosition"] = a
                    .get("endChar")
                    .filter(|v| !v.is_null())
                    .unwrap_or(sc)
                    .clone();
            } else {
                let s_line = get_f64(a, "startLine").unwrap_or(0.0) as usize;
                let e_line = a
                    .get("endLine")
                    .and_then(Value::as_f64)
                    .map(|v| v as usize)
                    .unwrap_or(s_line);
                let start = *line_offsets.get(s_line).unwrap_or(&0);
                let end_next = line_offsets
                    .get(e_line + 1)
                    .or(line_offsets.last())
                    .copied()
                    .unwrap_or(0);
                sel["startPosition"] = start.into();
                sel["endPosition"] = (end_next as i64 - 1).max(start as i64).into();
            }
            match a.get("manuallyAnchored") {
                Some(v) => sel["manuallyAnchored"] = v.clone(),
                None => {
                    sel.as_object_mut().unwrap().remove("manuallyAnchored");
                }
            }
        }
    }

    let Some(fd) = meta.get("formatData").filter(|v| truthy(v)) else {
        return;
    };
    let flag = |k: &str| fd.get(k).is_some_and(truthy);
    let get = |k: &str| fd.get(k).cloned();
    let mut out = Obj::new();
    let put = |out: &mut Obj, k: &str, v: Option<Value>| {
        if let Some(v) = v {
            out.insert(k.into(), v);
        }
    };
    if flag("hasPdfBinary") {
        if zip.has(&in_sources(&format!("{guid}.pdf"))) {
            put(
                &mut out,
                "pdfFilePath",
                Some(archive_handle(&guid, "pdf").into()),
            );
            put(&mut out, "pdfPageOffsets", get("pdfPageOffsets"));
            // Keep the sizes pass 1 measured, so a re-save can still flip box
            // codings into other tools' bottom-left convention.
            put(
                &mut out,
                "pdfPageSizes",
                source
                    .get("formatData")
                    .and_then(|f| f.get("pdfPageSizes"))
                    .cloned(),
            );
            source["formatData"] = Value::Object(out);
        }
    } else if flag("hasAudioBinary") {
        let audio_ext = get_nonempty(fd, "audioExt").unwrap_or("audio").to_string();
        let mut resolved =
            Some(audio_ext.clone()).filter(|e| zip.has(&in_sources(&format!("{guid}.{e}"))));
        if resolved.is_none()
            && audio_ext != "audio"
            && zip.has(&in_sources(&format!("{guid}.audio")))
        {
            resolved = Some("audio".into());
        }
        if let Some(ext) = resolved {
            put(
                &mut out,
                "audioFilePath",
                Some(archive_handle(&guid, &ext).into()),
            );
            put(&mut out, "audioExt", Some(ext.into()));
            for k in [
                "mimeType",
                "duration",
                "channels",
                "sampleRate",
                "lineTimes",
            ] {
                put(&mut out, k, get(k));
            }
            source["formatData"] = Value::Object(out);
        }
    } else if flag("hasVideoBinary") {
        let ext = get_nonempty(fd, "videoExt").unwrap_or("mp4").to_string();
        let existing = source
            .get("formatData")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let mut merged = existing.clone();
        let present = zip.has(&in_sources(&format!("{guid}.{ext}")));
        if present {
            merged.insert("videoFilePath".into(), archive_handle(&guid, &ext).into());
            let mt = fd
                .get("mimeType")
                .filter(|v| truthy(v))
                .or(existing.get("mimeType"))
                .cloned();
            match mt {
                Some(v) => merged.insert("mimeType".into(), v),
                None => merged.remove("mimeType"),
            };
        }
        let dur = fd
            .get("duration")
            .filter(|v| !v.is_null())
            .or(existing.get("duration").filter(|v| !v.is_null()))
            .cloned()
            .unwrap_or(0.into());
        merged.insert("duration".into(), dur);
        for k in ["width", "height"] {
            match get(k) {
                Some(v) => merged.insert(k.into(), v),
                None => merged.remove(k),
            };
        }
        if present {
            merged.insert("videoExt".into(), ext.into());
        }
        match get("lineTimes") {
            Some(v) => merged.insert("lineTimes".into(), v),
            None => merged.remove("lineTimes"),
        };
        source["formatData"] = Value::Object(merged);
    } else if flag("hasImageBinary") {
        let ext = get_nonempty(fd, "imageExt").unwrap_or("png").to_string();
        if zip.has(&in_sources(&format!("{guid}.{ext}"))) {
            put(
                &mut out,
                "imageFilePath",
                Some(archive_handle(&guid, &ext).into()),
            );
            put(&mut out, "mimeType", get("mimeType"));
            put(&mut out, "imageExt", Some(ext.into()));
            source["formatData"] = Value::Object(out);
        }
    } else {
        source["formatData"] = fd.clone();
    }
}

fn reconcile_survey(
    project: &mut Value,
    sources: &mut Vec<Value>,
    contents: &mut Map<String, Value>,
    variables: &[Value],
    cases: &[Value],
) {
    let mut case_doc_guids: HashSet<String> = HashSet::new();
    for c in cases {
        for g in get_arr(c, "sourceRefGuids")
            .iter()
            .filter_map(Value::as_str)
        {
            case_doc_guids.insert(g.to_string());
        }
    }
    let docs: Vec<(String, String, Vec<Value>)> = sources
        .iter()
        .filter(|s| case_doc_guids.contains(get_str(s, "guid").unwrap_or("")))
        .map(|s| {
            let sels = get_arr(s, "selections")
                .iter()
                .map(|sel| {
                    json!({
                        "guid": sel.get("guid"),
                        "startPosition": sel.get("startPosition").filter(|v| !v.is_null()).cloned().unwrap_or(0.into()),
                        "endPosition": sel.get("endPosition").filter(|v| !v.is_null()).cloned().unwrap_or(0.into()),
                        "codings": sel.get("codings").filter(|v| !v.is_null()).cloned().unwrap_or(json!([])),
                    })
                })
                .collect();
            (
                get_str(s, "guid").unwrap_or("").to_string(),
                get_str(s, "plainTextContent").unwrap_or("").to_string(),
                sels,
            )
        })
        .collect();

    let mut doc_tag_target: HashMap<String, (String, String)> = HashMap::new();
    let has_side_table_survey = sources.iter().any(|s| {
        s.get("formatData")
            .and_then(|f| f.get("survey"))
            .is_some_and(truthy)
    });
    if !has_side_table_survey && !variables.is_empty() {
        let name = get_nonempty(project, "name")
            .map(|n| format!("{n} (survey)"))
            .unwrap_or_else(|| "Imported Survey".into());
        let r = refi_to_survey(variables, cases, &docs, &name);
        let survey_guid = new_guid();
        let survey_name = r.survey.get("name").cloned().unwrap_or(Value::Null);
        sources.push(json!({
            "guid": survey_guid,
            "name": survey_name,
            "sourceType": "survey",
            "selections": r.cell_selections,
            "formatData": { "survey": r.survey, "rawCsv": "" },
        }));
        for (doc, resp) in r.doc_to_respondent {
            doc_tag_target.insert(doc, (survey_guid.clone(), resp));
        }
    }

    // Tags on respondent docs become respondent tags; strip the doc members.
    if let Some(sets) = project.get_mut("sets").and_then(Value::as_array_mut) {
        for set in sets.iter_mut() {
            let doc_refs: Vec<String> = get_arr(set, "memberSourceGuids")
                .iter()
                .filter_map(Value::as_str)
                .filter(|g| case_doc_guids.contains(*g))
                .map(str::to_string)
                .collect();
            if doc_refs.is_empty() {
                continue;
            }
            let kept: Vec<Value> = get_arr(set, "memberSourceGuids")
                .iter()
                .filter(|g| !g.as_str().is_some_and(|g| case_doc_guids.contains(g)))
                .cloned()
                .collect();
            set["memberSourceGuids"] = kept.into();
            for d in doc_refs {
                let Some((sg, id)) = doc_tag_target.get(&d) else {
                    continue;
                };
                if !set
                    .get("memberSurveyRespondents")
                    .is_some_and(Value::is_array)
                {
                    set["memberSurveyRespondents"] = json!([]);
                }
                let members = set["memberSurveyRespondents"].as_array_mut().unwrap();
                if !members
                    .iter()
                    .any(|m| get_str(m, "sourceGuid") == Some(sg) && get_str(m, "id") == Some(id))
                {
                    members.push(json!({ "sourceGuid": sg, "id": id }));
                }
            }
        }
    }

    sources.retain(|s| !case_doc_guids.contains(get_str(s, "guid").unwrap_or("")));
    for g in &case_doc_guids {
        contents.remove(g);
    }
}
