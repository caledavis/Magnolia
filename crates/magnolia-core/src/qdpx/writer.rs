//! Project JSON + source contents → .qdpx.
//!
//! Guards refuse saves that would destroy data (an empty payload over a
//! non-empty file, sources with no loaded text, binaries whose bytes can't be
//! found); everything else is a fresh archive written atomically.

use super::archive::Archive;
use super::archive_write::AtomicZip;
use super::checkout::{EDITOR_ENTRY, LOCK_ENTRY, PROJECT_ID_ENTRY};
use super::serializer::{audio_extension_for, representation_guid_for, serialize_project};
use super::transcript_refi::build_transcript;
use crate::binary_store::BinaryStore;
use crate::util::{Obj, get_arr, get_nonempty, get_str, has, now_iso, truthy};
use base64::Engine;
use serde_json::{Map, Value, json};
use std::collections::HashSet;
use std::path::Path;

#[derive(Debug)]
pub enum WriteError {
    /// Refused to protect existing data; surfaced as a warning, not a crash.
    Guard(String),
    Io(String),
}

impl std::fmt::Display for WriteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WriteError::Guard(m) | WriteError::Io(m) => f.write_str(m),
        }
    }
}

impl From<std::io::Error> for WriteError {
    fn from(e: std::io::Error) -> Self {
        WriteError::Io(e.to_string())
    }
}

#[derive(Default)]
pub struct WriteOptions<'a> {
    /// Archive to carry binaries (and the lock) forward from; defaults to the
    /// target path. Save As passes the currently-open project.
    pub carry_forward_from: Option<&'a Path>,
    /// Import overlay holding not-yet-saved binaries.
    pub store: Option<&'a BinaryStore>,
    /// "Create a Copy": don't carry the checkout lock / project id forward.
    pub drop_lock: bool,
    pub app_version: &'a str,
    /// Stamped into magnolia-editor.json (from the user's preferences).
    pub editor_name: &'a str,
}

fn is_payload_empty(p: &Value) -> bool {
    [
        "sources",
        "codes",
        "sets",
        "savedQueries",
        "memos",
        "quotes",
        "savedAnalyses",
    ]
    .iter()
    .all(|k| get_arr(p, k).is_empty())
}

/// Count source elements in the .qde currently on disk (0 if unreadable).
fn existing_source_count_on_disk(path: &Path) -> usize {
    let Ok(mut a) = Archive::open(path) else {
        return 0;
    };
    let Some(qde) = a.qde_name() else { return 0 };
    let Some(xml) = a.read_utf8(&qde) else {
        return 0;
    };
    let re =
        regex::Regex::new(r"<(?:TextSource|PDFSource|AudioSource|VideoSource|PictureSource)\b")
            .unwrap();
    re.find_iter(&xml).count()
}

fn file_size(path: &Path) -> Option<u64> {
    std::fs::metadata(path).ok().map(|m| m.len())
}

/// The .qde filename: `<projectName>.qde` like Atlas.ti / NVivo, falling
/// back to `project.qde`.
fn qde_filename_for(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if r#"\/:*?"<>|"#.contains(c) || (c as u32) < 0x20 {
                '_'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() {
        "project.qde".into()
    } else {
        format!("{cleaned}.qde")
    }
}

pub fn write_qdpx(
    path: &Path,
    project: &mut Value,
    contents: &Map<String, Value>,
    opts: &WriteOptions,
) -> Result<(), WriteError> {
    let sources = get_arr(project, "sources").to_vec();

    // Document-loss guard: never overwrite on-disk sources with zero sources.
    if sources.is_empty() {
        let on_disk = existing_source_count_on_disk(path);
        if on_disk > 0 {
            return Err(WriteError::Guard(format!(
                "Refusing to overwrite \"{}\" — incoming payload has 0 sources but the file currently contains {on_disk}. \
                 This usually means a bug reset the document store after the file was opened. Use Save As to a new path if \
                 you really want to save an empty project.",
                path.display()
            )));
        }
    }
    // All-empty safety net.
    if is_payload_empty(project)
        && let Some(size) = file_size(path).filter(|s| *s > 2048)
    {
        return Err(WriteError::Guard(format!(
            "Refusing to overwrite \"{}\" ({size} bytes) with an empty project. Use Save As if you really want to save an empty project.",
            path.display()
        )));
    }
    // Content-loss guard: sources present but no text loaded at all means
    // the project never opened fully. Image-only projects are exempt.
    let text_bearing = sources
        .iter()
        .filter(|s| get_str(s, "sourceType") != Some("image"))
        .count();
    if text_bearing > 0 && contents.is_empty() && file_size(path).is_some_and(|s| s > 2048) {
        return Err(WriteError::Guard(format!(
            "Refusing to overwrite \"{}\" — the project has {text_bearing} document(s) but no text content is loaded for any of them. \
             This usually means the project did not open fully; saving now would erase the document text. Reopen the project, \
             and if the problem persists restore from a backup.",
            path.display()
        )));
    }

    project["modifiedDateTime"] = now_iso().into();

    // Prepared copy for the serializer: every source points at its .txt, and
    // audio/video carry a <Transcript> built from their text + line times.
    let mut prepared = project.clone();
    let mut prepared_sources = Vec::with_capacity(sources.len());
    for s in &sources {
        let guid = get_str(s, "guid").unwrap_or("");
        let mut c = s.clone();
        let o = c.as_object_mut().unwrap();
        o.insert(
            "plainTextPath".into(),
            format!("internal://{guid}.txt").into(),
        );
        o.remove("plainTextContent");
        let kind = get_str(s, "sourceType").unwrap_or("");
        if kind == "audio" || kind == "video" {
            let text = contents.get(guid).and_then(Value::as_str).unwrap_or("");
            let lt = s.get("formatData").and_then(|f| f.get("lineTimes"));
            if let Some(t) = build_transcript(guid, text, lt, get_arr(s, "selections")) {
                o.insert("_refiTranscript".into(), t);
            }
        }
        // Box codings need page heights to flip into other tools' bottom-left
        // convention; derive them for fresh imports that don't carry any.
        if kind == "pdf"
            && let Some(fd) = s.get("formatData").filter(|f| truthy(f))
            && !has(fd, "pdfPageSizes")
            && get_arr(s, "selections")
                .iter()
                .any(|sel| has(sel, "pdfRegion"))
        {
            let bytes: Option<Vec<u8>> = if let Some(b64) = get_nonempty(fd, "pdfBase64") {
                base64::engine::general_purpose::STANDARD.decode(b64).ok()
            } else {
                get_str(fd, "pdfFilePath")
                    .filter(|p| p.starts_with("magnolia-bin://overlay/"))
                    .and_then(|h| opts.store.and_then(|st| st.overlay_bytes(h)))
                    .map(|b| b.as_ref().clone())
            };
            if let Some(sizes) = bytes.and_then(|b| crate::pdf_info::page_sizes(&b).ok()) {
                o.get_mut("formatData").unwrap()["pdfPageSizes"] = sizes.into();
            }
        }
        prepared_sources.push(c);
    }
    prepared["sources"] = prepared_sources.into();
    let xml = serialize_project(&prepared, opts.app_version);

    let mut zip = AtomicZip::create(path)?;
    zip.add(
        &qde_filename_for(get_str(project, "name").unwrap_or("")),
        xml.as_bytes(),
    )?;

    for s in &sources {
        let kind = get_str(s, "sourceType").unwrap_or("");
        if kind == "image" {
            continue;
        }
        let guid = get_str(s, "guid").unwrap_or("");
        let Some(content) = contents.get(guid) else {
            continue;
        };
        let text = crate::util::js_to_string(content);
        let name = if kind == "pdf" {
            representation_guid_for(guid)
        } else {
            guid.to_string()
        };
        zip.add(&format!("sources/{name}.txt"), text.as_bytes())?;
    }

    let json_entry =
        |zip: &mut AtomicZip, name: &str, v: &Value| zip.add(name, v.to_string().as_bytes());
    if !get_arr(project, "savedQueries").is_empty() {
        json_entry(&mut zip, "magnolia-queries.json", &project["savedQueries"])?;
    }
    if !get_arr(project, "logbookEntries").is_empty() {
        json_entry(
            &mut zip,
            "magnolia-logbook.json",
            &project["logbookEntries"],
        )?;
    }
    let memos = get_arr(project, "memos");
    if !memos.is_empty() {
        json_entry(&mut zip, "magnolia-memos.json", &project["memos"])?;
        for m in memos {
            let body = m
                .get("content")
                .filter(|v| !v.is_null())
                .map(crate::util::js_to_string)
                .unwrap_or_default();
            zip.add(
                &format!("sources/{}.txt", get_str(m, "guid").unwrap_or("")),
                body.as_bytes(),
            )?;
        }
    }
    if !get_arr(project, "quotes").is_empty() {
        json_entry(&mut zip, "magnolia-quotes.json", &project["quotes"])?;
    }
    if !get_arr(project, "savedAnalyses").is_empty() {
        json_entry(
            &mut zip,
            "magnolia-analyses.json",
            &project["savedAnalyses"],
        )?;
    }
    if let Some(tabs) = project.get("tabState").filter(|t| truthy(t)) {
        let has_tabs = !get_arr(tabs, "openTabs").is_empty();
        let has_counters = tabs
            .get("perToolCounters")
            .and_then(Value::as_object)
            .is_some_and(|m| !m.is_empty());
        if has_tabs || has_counters {
            json_entry(&mut zip, "magnolia-tabs.json", tabs)?;
        }
    }
    let folders = get_arr(project, "folders");
    let source_folder = project
        .get("sourceFolder")
        .and_then(Value::as_object)
        .filter(|m| !m.is_empty());
    if !folders.is_empty() || source_folder.is_some() {
        let v = json!({ "folders": folders, "sourceFolder": source_folder.cloned().unwrap_or_default() });
        json_entry(&mut zip, "magnolia-folders.json", &v)?;
    }

    // Tag categories + the Magnolia-only bits of each tag.
    let mut tag_ext = Obj::new();
    if !get_arr(project, "tagCategories").is_empty() {
        tag_ext.insert("categories".into(), project["tagCategories"].clone());
    }
    let tag_meta: Vec<Value> = get_arr(project, "sets")
        .iter()
        .filter(|s| {
            has(s, "categoryGuid")
                || has(s, "value")
                || !get_arr(s, "memberSurveyRespondents").is_empty()
                || !get_arr(s, "memberSurveyQuestions").is_empty()
        })
        .map(|s| {
            let mut o = Obj::new();
            o.insert("guid".into(), s.get("guid").cloned().unwrap_or(Value::Null));
            for k in [
                "categoryGuid",
                "value",
                "memberSurveyRespondents",
                "memberSurveyQuestions",
            ] {
                if let Some(v) = s.get(k).filter(|v| !v.is_null()) {
                    o.insert(k.into(), v.clone());
                }
            }
            Value::Object(o)
        })
        .collect();
    if !tag_meta.is_empty() {
        tag_ext.insert("tagMeta".into(), tag_meta.into());
    }
    if !tag_ext.is_empty() {
        json_entry(&mut zip, "magnolia-tags.json", &Value::Object(tag_ext))?;
    }

    let mut hotkeys = Vec::new();
    fn collect(codes: &[Value], out: &mut Vec<Value>) {
        for c in codes {
            if let Some(h) = c.get("hotkey").filter(|v| !v.is_null()) {
                out.push(json!({ "guid": c.get("guid"), "hotkey": h }));
            }
            collect(get_arr(c, "children"), out);
        }
    }
    collect(get_arr(project, "codes"), &mut hotkeys);
    if !hotkeys.is_empty() {
        json_entry(
            &mut zip,
            "magnolia-codes.json",
            &json!({ "hotkeys": hotkeys }),
        )?;
    }

    // ── Embed every imported binary ──
    // Bytes come from (in order) inline base64, the import overlay, a legacy
    // temp path, or the copy already inside the archive on disk — so a
    // re-save can never drop a binary the project once held.
    let carry_path = opts.carry_forward_from.unwrap_or(path);
    let mut existing = Archive::open(carry_path).ok();
    let existing_dir = existing
        .as_ref()
        .map(|a| a.sources_dir())
        .unwrap_or_else(|| "sources".into());
    let mut written: HashSet<String> = HashSet::new();
    let mut persisted_overlays: Vec<(String, String)> = Vec::new();

    for s in &sources {
        let kind = get_str(s, "sourceType").unwrap_or("");
        if !matches!(kind, "pdf" | "image" | "audio" | "video") {
            continue;
        }
        let guid = get_str(s, "guid").unwrap_or("").to_string();
        let empty = json!({});
        let fd = s.get("formatData").filter(|f| truthy(f)).unwrap_or(&empty);
        let ext = match kind {
            "pdf" => "pdf".to_string(),
            "image" => get_nonempty(fd, "imageExt").unwrap_or("png").to_string(),
            "audio" => audio_extension_for(s),
            _ => get_nonempty(fd, "videoExt").unwrap_or("mp4").to_string(),
        };
        let internal = format!("{guid}.{ext}");
        let handle_key = match kind {
            "pdf" => "pdfFilePath",
            "image" => "imageFilePath",
            "audio" => "audioFilePath",
            _ => "videoFilePath",
        };
        let handle = get_nonempty(fd, handle_key);
        let is_overlay = handle.is_some_and(|h| h.starts_with("magnolia-bin://overlay/"));
        let is_handle = handle.is_some_and(|h| h.starts_with("magnolia-bin://"));
        // An archive handle names the binary's real in-archive file (other
        // tools don't use `<guid>.<ext>`); we still WRITE it as `<guid>.<ext>`.
        let carry_name = handle
            .and_then(|h| h.strip_prefix("magnolia-bin://archive/"))
            .map(str::to_string)
            .unwrap_or_else(|| internal.clone());

        let mut bytes: Option<Vec<u8>> = None;
        if kind == "pdf"
            && let Some(b64) = get_nonempty(fd, "pdfBase64")
        {
            bytes = base64::engine::general_purpose::STANDARD.decode(b64).ok();
        } else if is_overlay {
            bytes = opts
                .store
                .and_then(|st| st.overlay_bytes(handle.unwrap()))
                .map(|b| b.as_ref().clone());
        } else if let Some(p) = handle.filter(|_| !is_handle) {
            bytes = std::fs::read(p).ok();
        }

        let dest = format!("sources/{internal}");
        if let Some(b) = bytes {
            zip.add(&dest, &b)?;
            written.insert(guid.clone());
            if is_overlay {
                persisted_overlays.push((handle.unwrap().to_string(), guid.clone()));
            }
            continue;
        }
        // Carry forward from the archive on disk, raw-copied.
        if let Some(a) = existing.as_mut() {
            let exact = format!("{existing_dir}/{carry_name}");
            let src_name = if a.has(&exact) {
                Some(exact)
            } else {
                let prefix = format!("{existing_dir}/{guid}.");
                a.names()
                    .iter()
                    .find(|n| n.starts_with(&prefix) && !n.to_lowercase().ends_with(".txt"))
                    .cloned()
            };
            if let Some(n) = src_name {
                zip.copy_from(a.inner(), &n, &dest)?;
                written.insert(guid.clone());
            }
        }
    }

    // Source metadata side table.
    let source_meta: Vec<Value> = sources
        .iter()
        .filter(|s| {
            get_nonempty(s, "sourceType").is_some_and(|t| t != "text")
                || has(s, "formatData")
                || get_arr(s, "selections")
                    .iter()
                    .any(|sel| has(sel, "pdfRegion"))
        })
        .map(|s| source_meta_for(s, &written))
        .collect();
    if !source_meta.is_empty() {
        json_entry(
            &mut zip,
            "magnolia-sources.json",
            &json!({ "sourceMeta": source_meta }),
        )?;
    }

    // Completeness guard: refuse a silently-incomplete project.
    let dropped: Vec<String> = sources
        .iter()
        .filter(|s| {
            let Some(fd) = s.get("formatData").filter(|f| truthy(f)) else {
                return false;
            };
            let declares = match get_str(s, "sourceType") {
                Some("pdf") => has(fd, "pdfBase64") || has(fd, "pdfFilePath"),
                Some("image") => has(fd, "imageFilePath"),
                Some("audio") => has(fd, "audioFilePath"),
                Some("video") => has(fd, "videoFilePath"),
                _ => false,
            };
            declares && !written.contains(get_str(s, "guid").unwrap_or(""))
        })
        .map(|s| {
            get_nonempty(s, "name")
                .or_else(|| get_str(s, "guid"))
                .unwrap_or("")
                .to_string()
        })
        .collect();
    if !dropped.is_empty() {
        return Err(WriteError::Guard(format!(
            "Refusing to save \"{}\" — the binary content for {} imported document(s) could not be located ({}). Their bytes \
             were not in memory, the temp cache, or the existing project file, so saving now would write them out empty. \
             Re-import the affected document(s) and try again.",
            path.display(),
            dropped.len(),
            dropped.join(", ")
        )));
    }

    // Carry the checkout lock + project id forward, re-reading them as late
    // as possible: a check-out racing this save must not be erased by it.
    if !opts.drop_lock
        && let Ok(mut latest) = Archive::open(carry_path)
    {
        for name in [LOCK_ENTRY, PROJECT_ID_ENTRY] {
            if let Some(b) = latest.read(name) {
                zip.add(name, &b)?;
            }
        }
    }

    // Who last saved this project, written fresh on every save.
    zip.add(
        EDITOR_ENTRY,
        json!({ "lastEditedBy": opts.editor_name, "lastEditedAt": now_iso() })
            .to_string()
            .as_bytes(),
    )?;

    // Release the archive we read from before renaming over it (Windows).
    drop(existing);
    zip.commit()?;

    // The archive now durably holds the overlay binaries; free the buffers.
    if let Some(st) = opts.store {
        for (h, g) in persisted_overlays {
            st.mark_persisted(&h, &g);
        }
    }
    Ok(())
}

fn source_meta_for(s: &Value, written: &HashSet<String>) -> Value {
    let guid = get_str(s, "guid").unwrap_or("");
    let st = get_str(s, "sourceType").unwrap_or("");
    let mut meta = Obj::new();
    meta.insert("guid".into(), guid.into());
    if !st.is_empty() && st != "text" {
        meta.insert("sourceType".into(), st.into());
    }
    // Image regions live in the XML as <PictureSelection>s instead.
    if st != "image" {
        let regions: Vec<Value> = get_arr(s, "selections")
            .iter()
            .filter(|sel| has(sel, "pdfRegion"))
            .map(|sel| json!({ "guid": sel.get("guid"), "region": sel.get("pdfRegion") }))
            .collect();
        if !regions.is_empty() {
            meta.insert("pdfRegionSelections".into(), regions.into());
        }
    }
    // Survey-cell selections are cell-relative: persisted whole here.
    if st == "survey" {
        let cells: Vec<Value> = get_arr(s, "selections")
            .iter()
            .filter(|sel| has(sel, "surveyCell"))
            .cloned()
            .collect();
        if !cells.is_empty() {
            meta.insert("surveyCellSelections".into(), cells.into());
        }
    }
    let fd = s.get("formatData").filter(|v| !v.is_null());
    let pick = |keys: &[&str]| -> Obj {
        let mut o = Obj::new();
        for k in keys {
            if let Some(v) = fd.and_then(|f| f.get(*k)).filter(|v| !v.is_null()) {
                o.insert((*k).into(), v.clone());
            }
        }
        o
    };
    let has_binary = written.contains(guid);
    match st {
        "pdf" => {
            let mut o = pick(&["pdfPageOffsets"]);
            o.insert("hasPdfBinary".into(), has_binary.into());
            meta.insert("formatData".into(), Value::Object(o));
        }
        "image" => {
            let mut o = pick(&["mimeType", "imageExt"]);
            o.insert("hasImageBinary".into(), has_binary.into());
            meta.insert("formatData".into(), Value::Object(o));
        }
        "audio" => {
            let mut o = pick(&[
                "mimeType",
                "duration",
                "channels",
                "sampleRate",
                "lineTimes",
            ]);
            o.insert("hasAudioBinary".into(), has_binary.into());
            o.insert("audioExt".into(), audio_extension_for(s).into());
            meta.insert("formatData".into(), Value::Object(o));
        }
        "video" => {
            let mut o = pick(&[
                "mimeType",
                "videoExt",
                "duration",
                "width",
                "height",
                "lineTimes",
            ]);
            o.insert("hasVideoBinary".into(), has_binary.into());
            meta.insert("formatData".into(), Value::Object(o));
            let anchors: Vec<Value> = get_arr(s, "selections")
                .iter()
                .filter(|sel| !get_arr(sel, "codings").is_empty())
                .map(|sel| {
                    json!({
                        "guid": sel.get("guid"),
                        "startChar": sel.get("startPosition").filter(|v| !v.is_null()).cloned().unwrap_or(0.into()),
                        "endChar": sel.get("endPosition").filter(|v| !v.is_null()).cloned().unwrap_or(0.into()),
                        "manuallyAnchored": sel.get("manuallyAnchored").is_some_and(truthy),
                    })
                })
                .collect();
            if !anchors.is_empty() {
                meta.insert("videoSelectionAnchors".into(), anchors.into());
            }
        }
        _ => {
            if let Some(f) = fd.filter(|f| truthy(f)) {
                meta.insert("formatData".into(), f.clone());
            }
        }
    }
    Value::Object(meta)
}

/// Create an empty .qdpx at `path`; returns the project name (the file stem).
pub fn create_empty_project_file(
    path: &Path,
    app_version: &str,
    editor_name: &str,
) -> Result<String, WriteError> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let re = regex::Regex::new(r"(?i)\.qdpx$").unwrap();
    let name = re.replace(&name, "").to_string();
    let user = uuid::Uuid::new_v4().to_string();
    let mut project = json!({
        "name": name, "origin": format!("Magnolia {app_version}"),
        "users": [{ "guid": user, "name": "User" }],
        "creatingUserGUID": user, "creationDateTime": now_iso(),
        "codes": [], "sources": [], "sets": [], "notes": [], "tagCategories": [],
        "savedQueries": [], "logbookEntries": [], "memos": [], "quotes": [], "savedAnalyses": [],
    });
    write_qdpx(
        path,
        &mut project,
        &Map::new(),
        &WriteOptions {
            app_version,
            editor_name,
            ..Default::default()
        },
    )?;
    Ok(name)
}
