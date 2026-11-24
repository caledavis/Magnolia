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
        "description",
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
    report(
        &crate::message::tr("stage.readingFile", "Reading file", &[]),
        0,
        0,
    );
    let mut zip = Archive::open(path).map_err(|e| {
        crate::message::tr(
            "openProject",
            "Could not open project: {{detail}}",
            &[("detail", &e.to_string())],
        )
    })?;
    report(
        &crate::message::tr("stage.unpacking", "Unpacking archive", &[]),
        0,
        0,
    );
    let sources_dir = zip.sources_dir();
    let qde = zip.qde_name().ok_or_else(|| {
        crate::message::tr(
            "qdpxNoProject",
            "Invalid QDPX file: missing project.qde",
            &[],
        )
    })?;
    report(
        &crate::message::tr("stage.parsing", "Parsing project", &[]),
        0,
        0,
    );
    let xml = zip.read_utf8(&qde).ok_or_else(|| {
        crate::message::tr(
            "qdpxUnreadableProject",
            "Invalid QDPX file: unreadable project.qde",
            &[],
        )
    })?;
    let mut project = deserialize_project(&xml)?;
    // Saved by a newer Magnolia: shown, but not saved over (see format.rs).
    if let Some(newer) = super::format::newer_format_in(&mut zip) {
        project["newerFormat"] = json!({ "savedBy": newer.saved_by });
    }
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
    let loading = crate::message::tr("stage.loadingDocuments", "Loading documents", &[]);
    for (done, source) in sources.iter_mut().enumerate() {
        load_source(
            source,
            &mut zip,
            &sources_dir,
            &origin,
            &mut source_contents,
        );
        report(&loading, done + 1, total);
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

    apply_saved_time_ranges(&mut sources);

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
            repair_line_number_anchors(sels, &text, &lt);
        }
    }

    // ── Survey REFI reconciliation ──
    let refi_variables = take(&mut project, "_refiVariables")
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default();
    let refi_cases = take(&mut project, "_refiCases")
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default();
    // A document's own variable values, taken off before anything else.
    let document_values: Vec<(String, Vec<Value>)> = sources
        .iter_mut()
        .filter_map(|s| {
            let values = take(s, "_refiVariableValues")?.as_array()?.clone();
            Some((get_str(s, "guid").unwrap_or("").to_string(), values))
        })
        .collect();
    // Cases describing documents (as NVivo writes its cases) become tags on
    // those documents; the rest are a survey's respondents.
    let (case_tags, survey_cases) = split_cases(&refi_variables, &refi_cases, &sources);
    if !survey_cases.is_empty() {
        reconcile_survey(
            &mut project,
            &mut sources,
            &mut source_contents,
            &refi_variables,
            &survey_cases,
        );
    }
    variables_as_tags(&mut project, &sources, &refi_variables, &case_tags, &document_values);

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

    // Timeline codings belong to the recording whether or not its file is
    // in the archive (a missing file is reported, and can be relinked);
    // dropping them here would lose them at the next save.
    if st == "audio" || st == "video" {
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
    }

    match st.as_str() {
        "audio" => {
            // Foreign imports carry the binary only via plainTextPath; advertise
            // the archive handle so it plays. Magnolia's side table later
            // overwrites this with richer recorded metadata.
            if let Some(name) = internal.as_ref().filter(|n| zip.has(&in_sources(n))) {
                let ext = Some(ext_of(name))
                    .filter(|e| !e.is_empty())
                    .unwrap_or_else(|| "m4a".into());
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
            let bytes = internal.as_ref().and_then(|name| zip.read(&in_sources(name)));
            // Box sizes now; text is extracted in the renderer with pdf.js.
            let page_sizes: Vec<Value> = bytes
                .as_ref()
                .and_then(|b| crate::pdf_info::page_sizes(b).ok())
                .unwrap_or_default();
            // Region codings are kept even when the PDF itself is missing
            // (it's reported and can be relinked); without its page sizes a
            // bottom-left-origin file's boxes can't be flipped, but dropping
            // them would lose them at the next save.
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
            if let (Some(name), Some(_)) = (internal.as_ref(), bytes.as_ref()) {
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
            // Region codings are kept even when the image file is missing.
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
            if let Some(name) = internal.as_ref().filter(|n| zip.has(&in_sources(n))) {
                let ext = Some(ext_of(name))
                    .filter(|e| !e.is_empty())
                    .unwrap_or_else(|| "png".into());
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
            // Its text file, or else the text held inline in the note.
            let content = internal_name(get_str(n, "plainTextPath"))
                .and_then(|m| zip.read_text(&in_sources(m)))
                .filter(|t| !t.is_empty())
                .or_else(|| get_str(n, "plainTextContent").map(str::to_string))
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

/// The transcript lines a time range covers: those whose time falls in
/// [start, end), else the last line timed at or before start, else line 0.
/// Mirrors deriveLineAnchorsFromTimeRange in the renderer.
fn lines_for_time(start: f64, end: f64, line_times: &Value) -> (usize, usize) {
    let Some(lt) = line_times.as_object() else {
        return (0, 0);
    };
    let timed: Vec<(usize, f64)> = lt
        .iter()
        .filter_map(|(k, v)| Some((k.parse::<usize>().ok()?, v.as_f64()?)))
        .collect();
    let covered: Vec<usize> = timed.iter().filter(|(_, t)| *t >= start && *t < end).map(|(i, _)| *i).collect();
    if let (Some(lo), Some(hi)) = (covered.iter().min(), covered.iter().max()) {
        return (*lo, *hi);
    }
    timed
        .iter()
        .filter(|(_, t)| *t <= start)
        .max_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(i, _)| (*i, *i))
        .unwrap_or((0, 0))
}

/// Builds before 2.1 stored a timeline coding's transcript place as LINE
/// numbers in startPosition / endPosition, which everything else reads as
/// characters. A coding whose positions are exactly the lines its time
/// range covers (and that wasn't coded on the text) gets the characters of
/// those lines instead.
fn repair_line_number_anchors(sels: &mut [Value], text: &str, line_times: &Value) {
    let offsets = line_start_offsets_with_end(text);
    if offsets.len() < 2 {
        return;
    }
    for sel in sels.iter_mut() {
        let Some(tr) = sel.get("timeRange").filter(|t| truthy(t)) else {
            continue;
        };
        let (Some(ts), Some(te)) = (get_f64(tr, "startTime"), get_f64(tr, "endTime")) else {
            continue;
        };
        let (Some(s), Some(e)) = (get_f64(sel, "startPosition"), get_f64(sel, "endPosition")) else {
            continue;
        };
        if e <= s {
            continue;
        }
        let from_text = derive_line_time_range(text, s, e, Some(line_times)).is_some_and(|d| {
            (get_f64(&d, "startTime").unwrap_or(f64::NAN) - ts).abs() < 5e-4
                && (get_f64(&d, "endTime").unwrap_or(f64::NAN) - te).abs() < 5e-4
        });
        if from_text {
            continue;
        }
        let (lo, hi) = lines_for_time(ts, te, line_times);
        if (s as usize, e as usize) != (lo, hi) || s.fract() != 0.0 || e.fract() != 0.0 {
            continue;
        }
        let last = offsets.len() - 1;
        let start = offsets[lo.min(last)];
        let end = offsets[(hi + 1).min(last)].saturating_sub(1).max(start);
        sel["startPosition"] = start.into();
        sel["endPosition"] = end.into();
    }
}

/// A video coding's exact time range from the side table. The XML can only
/// say which transcript text a coding covers (line-granular time), so
/// without this a timeline coding would come back rounded to whole lines.
fn apply_saved_time_ranges(sources: &mut [Value]) {
    for source in sources.iter_mut() {
        let Some(Value::Object(ranges)) = take(source, "_savedTimeRanges") else {
            continue;
        };
        if let Some(sels) = source.get_mut("selections").and_then(Value::as_array_mut) {
            for sel in sels.iter_mut() {
                if let Some(tr) = get_str(sel, "guid").and_then(|g| ranges.get(g)) {
                    sel["timeRange"] = tr.clone();
                }
            }
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
    if let Some(link) = meta.get("zoteroLink").filter(|v| truthy(v)) {
        source["zoteroLink"] = link.clone();
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
        // Exact time ranges, applied once the transcript's codings have been
        // folded back onto the video (see apply_saved_time_ranges).
        let ranges: Obj = anchors
            .iter()
            .filter_map(|a| {
                let g = get_str(a, "guid")?;
                let tr = a.get("timeRange").filter(|v| truthy(v))?;
                Some((g.to_string(), tr.clone()))
            })
            .collect();
        if !ranges.is_empty() {
            source["_savedTimeRanges"] = Value::Object(ranges);
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

/// Which Cases describe documents, and which are a survey's respondents.
/// Magnolia writes each survey respondent as a Case: its values are of
/// Magnolia's survey variables (marked in their descriptions), and its one
/// document holds the respondent's answers under `[[MQ:…]]` headings.
/// Another program's case that refers to documents describes them, and
/// becomes tags on them; one that refers to none stays a respondent, as
/// before (its values would have nowhere else to go).
fn split_cases(variables: &[Value], cases: &[Value], sources: &[Value]) -> (Vec<Value>, Vec<Value>) {
    let magnolia_variables: HashSet<&str> = variables
        .iter()
        .filter(|v| get_str(v, "description").is_some_and(|d| d.starts_with("magnolia:v1:")))
        .filter_map(|v| get_str(v, "guid"))
        .collect();
    let mut answer_documents: HashSet<&str> = HashSet::new();
    let mut documents: HashSet<&str> = HashSet::new();
    for s in sources {
        let Some(guid) = get_str(s, "guid") else {
            continue;
        };
        documents.insert(guid);
        if get_str(s, "plainTextContent").is_some_and(|t| t.split('\n').any(|l| l.starts_with("[[MQ:"))) {
            answer_documents.insert(guid);
        }
    }
    let (mut tags, mut respondents) = (Vec::new(), Vec::new());
    for c in cases {
        let refs: Vec<&str> = get_arr(c, "sourceRefGuids").iter().filter_map(Value::as_str).collect();
        let magnolia = get_arr(c, "values")
            .iter()
            .any(|v| get_str(v, "variableGuid").is_some_and(|g| magnolia_variables.contains(g)))
            || refs.iter().any(|g| answer_documents.contains(g));
        if !magnolia && refs.iter().any(|g| documents.contains(g)) {
            tags.push(c.clone());
        } else {
            respondents.push(c.clone());
        }
    }
    (tags, respondents)
}

/// Cases and document variables as tags. A case becomes a tag in the
/// category "Case" on the documents it refers to; each of its variable
/// values becomes a tag in a category named after the variable, on the same
/// documents. A document's own variable values become tags on it the same
/// way. Categories and tags already in the project (by name, and by value)
/// are used rather than made again.
fn variables_as_tags(
    project: &mut Value,
    sources: &[Value],
    variables: &[Value],
    cases: &[Value],
    document_values: &[(String, Vec<Value>)],
) {
    if cases.is_empty() && document_values.is_empty() {
        return;
    }
    let documents: HashSet<String> = sources
        .iter()
        .filter_map(|s| get_str(s, "guid").map(str::to_string))
        .collect();
    let mut tags = TagBuilder {
        categories: get_arr(project, "tagCategories").to_vec(),
        sets: get_arr(project, "sets").to_vec(),
    };
    // Made only for a file that has such cases.
    let case_category = (!cases.is_empty()).then(|| tags.category(&crate::message::tr("caseCategory", "Case", &[]), "text"));
    // Each variable's category, made in the order the file declares them.
    let used: HashSet<&str> = cases
        .iter()
        .flat_map(|c| get_arr(c, "values"))
        .chain(document_values.iter().flat_map(|(_, v)| v))
        .filter_map(|v| get_str(v, "variableGuid"))
        .collect();
    let mut category_of: HashMap<String, (String, String)> = HashMap::new();
    for v in variables {
        let Some(guid) = get_str(v, "guid").filter(|g| used.contains(g)) else {
            continue;
        };
        let Some(name) = get_nonempty(v, "name").map(str::trim).filter(|n| !n.is_empty()) else {
            continue;
        };
        let kind = match get_str(v, "typeOfVariable") {
            Some("Integer" | "Float") => "numeric",
            Some("Date") => "date",
            _ => "text",
        };
        category_of.insert(guid.to_string(), tags.category(name, kind));
    }
    let tag_values = |tags: &mut TagBuilder, values: &[Value], members: &[String]| {
        for v in values {
            let Some((category, name)) = get_str(v, "variableGuid").and_then(|g| category_of.get(g)) else {
                continue;
            };
            let value = super::survey_refi::value_to_string(v);
            let value = value.trim();
            if value.is_empty() {
                continue;
            }
            let tag = tags.tag(category, name, value, None);
            tags.add_members(tag, members);
        }
    };
    for (n, c) in cases.iter().enumerate() {
        let members: Vec<String> = get_arr(c, "sourceRefGuids")
            .iter()
            .filter_map(Value::as_str)
            .filter(|g| documents.contains(*g))
            .map(str::to_string)
            .collect();
        let name = get_nonempty(c, "name")
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("{}", n + 1));
        if let Some((category, category_name)) = &case_category {
            let tag = tags.tag(category, category_name, &name, get_nonempty(c, "description"));
            tags.add_members(tag, &members);
        }
        tag_values(&mut tags, get_arr(c, "values"), &members);
    }
    for (doc, values) in document_values {
        if documents.contains(doc) {
            tag_values(&mut tags, values, std::slice::from_ref(doc));
        }
    }
    project["tagCategories"] = tags.categories.into();
    project["sets"] = tags.sets.into();
}

struct TagBuilder {
    categories: Vec<Value>,
    sets: Vec<Value>,
}

impl TagBuilder {
    /// The category named `name` (ignoring case and surrounding spaces),
    /// made with `kind` if there's none: (guid, name).
    fn category(&mut self, name: &str, kind: &str) -> (String, String) {
        let same = |c: &&Value| get_str(c, "name").is_some_and(|n| n.trim().to_lowercase() == name.trim().to_lowercase());
        if let Some(c) = self.categories.iter().find(same) {
            return (get_str(c, "guid").unwrap_or("").to_string(), get_str(c, "name").unwrap_or("").to_string());
        }
        let guid = new_guid();
        self.categories.push(json!({ "guid": guid, "name": name, "type": kind }));
        (guid, name.to_string())
    }

    /// The category's tag for `value`, made if there's none: its index.
    fn tag(&mut self, category: &str, category_name: &str, value: &str, description: Option<&str>) -> usize {
        if let Some(i) = self.sets.iter().position(|s| {
            get_str(s, "categoryGuid") == Some(category)
                && get_str(s, "value").or_else(|| get_str(s, "name")) == Some(value)
        }) {
            return i;
        }
        let mut set = json!({
            "guid": new_guid(),
            "name": format!("{category_name}:{value}"),
            "categoryGuid": category,
            "value": value,
            "memberSourceGuids": [],
            "memberCodeGuids": [],
        });
        if let Some(d) = description {
            set["description"] = d.into();
        }
        self.sets.push(set);
        self.sets.len() - 1
    }

    fn add_members(&mut self, tag: usize, documents: &[String]) {
        let set = &mut self.sets[tag];
        if !set.get("memberSourceGuids").is_some_and(Value::is_array) {
            set["memberSourceGuids"] = json!([]);
        }
        let members = set["memberSourceGuids"].as_array_mut().unwrap();
        for d in documents {
            if !members.iter().any(|m| m.as_str() == Some(d)) {
                members.push(d.as_str().into());
            }
        }
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
