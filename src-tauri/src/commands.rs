//! IPC commands invoked by the renderer's `window.api` bridge
//! (src/renderer/platform/tauri-api.ts).
//!
//! Every command is `async`, so Tauri runs it off the main thread: project
//! reads and writes can take a while on large projects, and native dialogs
//! opened with the plugin's blocking API must not block the event loop.

use crate::print;
use crate::state::AppState;
use crate::storage;
use crate::windows::{self, MAIN};
use base64::Engine;
use magnolia_core::binary_store::{archive_file_name_from_handle, is_binary_handle};
use magnolia_core::convert;
use magnolia_core::qdpx::{archive, checkout, codebook, reader, writer};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, FileDialogBuilder};

type CmdResult<T> = Result<T, String>;

fn app_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

// ── Dialog helpers ──

fn dialog(
    app: &AppHandle,
    parent: Option<&WebviewWindow>,
    title: &str,
) -> FileDialogBuilder<tauri::Wry> {
    let mut d = app.dialog().file().set_title(title);
    // Parent the dialog so window managers keep it on top (on Linux an
    // unparented picker can open behind the window) and macOS shows a sheet.
    if let Some(w) = parent {
        d = d.set_parent(w);
    }
    d
}

fn to_path(p: tauri_plugin_dialog::FilePath) -> Option<PathBuf> {
    p.into_path().ok()
}

pub fn pick_qdpx(app: &AppHandle, parent: Option<&WebviewWindow>) -> Option<String> {
    dialog(app, parent, "Open QDPX Project")
        .add_filter("QDPX Projects", &["qdpx"])
        .blocking_pick_file()
        .and_then(to_path)
        .map(|p| p.to_string_lossy().into_owned())
}

fn save_dialog(
    app: &AppHandle,
    parent: &WebviewWindow,
    title: &str,
    default_name: &str,
    filter: (&str, &[&str]),
) -> Option<PathBuf> {
    let mut path = dialog(app, Some(parent), title)
        .set_file_name(default_name)
        .add_filter(filter.0, filter.1)
        .blocking_save_file()
        .and_then(to_path)?;
    // GTK doesn't append the filter's extension.
    if path.extension().is_none()
        && let Some(ext) = filter.1.first()
    {
        path.set_extension(ext);
    }
    Some(path)
}

fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

// ── Project open / read ──

fn load_project(window: &WebviewWindow, state: &AppState, path: &str) -> CmdResult<Value> {
    let label = window.label().to_string();
    let app = window.app_handle().clone();
    let progress = move |stage: &str, current: usize, total: usize| {
        windows::emit_to(
            &app,
            &label,
            "project-load-progress",
            json!({ "stage": stage, "current": current, "total": total }),
        );
    };
    let mut data = reader::read_qdpx(Path::new(path), Some(&progress))?;
    // Make this the live archive at once so viewers resolve handles before
    // the renderer's own path effect fires.
    state.store.set_active_project_path(Some(path));
    data["filePath"] = path.into();
    data["checkoutInfo"] =
        serde_json::to_value(checkout::read_checkout_marker(Path::new(path))).unwrap();
    Ok(data)
}

#[tauri::command]
pub async fn open_project(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> CmdResult<Value> {
    let Some(path) = pick_qdpx(&app, Some(&window)) else {
        return Ok(Value::Null);
    };
    load_project(&window, &state, &path)
}

#[tauri::command]
pub async fn pick_project_file(app: AppHandle, window: WebviewWindow) -> CmdResult<Option<String>> {
    Ok(pick_qdpx(&app, Some(&window)))
}

#[tauri::command]
pub async fn open_project_path(
    window: WebviewWindow,
    state: State<'_, AppState>,
    file_path: String,
) -> CmdResult<Value> {
    load_project(&window, &state, &file_path)
}

#[tauri::command]
pub async fn set_active_project_path(
    state: State<'_, AppState>,
    file_path: Option<String>,
) -> CmdResult<()> {
    state.store.set_active_project_path(file_path.as_deref());
    Ok(())
}

#[tauri::command]
pub async fn get_file_size(file_path: String) -> CmdResult<Option<u64>> {
    Ok(std::fs::metadata(file_path).ok().map(|m| m.len()))
}

/// Media bytes for a viewer: a `magnolia-bin://` handle, or a legacy real
/// path (self-healed from the archive if the temp copy was reaped).
#[tauri::command]
pub async fn read_media(
    state: State<'_, AppState>,
    handle: String,
    archive_path: Option<String>,
) -> CmdResult<Response> {
    state
        .store
        .note_active_project_path(archive_path.as_deref());
    if is_binary_handle(&handle) {
        return state
            .store
            .resolve(&handle)
            .map(|b| Response::new(b.as_ref().clone()))
            .ok_or_else(|| format!("ENOENT: binary not available: {handle}"));
    }
    match std::fs::read(&handle) {
        Ok(b) => Ok(Response::new(b)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let name = Path::new(&handle)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            state
                .store
                .read_archive_by_name(&name)
                .map(Response::new)
                .ok_or_else(|| format!("ENOENT: {e}"))
        }
        Err(e) => Err(e.to_string()),
    }
}

// ── Check-out / check-in ──

#[tauri::command]
pub async fn read_checkout_marker(
    file_path: String,
) -> CmdResult<Option<checkout::CheckoutMarker>> {
    Ok(checkout::read_checkout_marker(Path::new(&file_path)))
}

#[tauri::command]
pub async fn check_out_project(
    file_path: String,
    user_name: String,
    steal: Option<bool>,
) -> CmdResult<checkout::CheckoutWriteResult> {
    let action = checkout::CheckoutAction::CheckOut {
        steal: steal.unwrap_or(false),
    };
    checkout::write_checkout_marker(Path::new(&file_path), &user_name, action)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn check_in_project(
    file_path: String,
    user_name: String,
) -> CmdResult<checkout::CheckoutWriteResult> {
    checkout::write_checkout_marker(
        Path::new(&file_path),
        &user_name,
        checkout::CheckoutAction::CheckIn,
    )
    .map_err(|e| e.to_string())
}

// ── Merge ──

/// Load a second .qdpx for comparison without touching the active project.
#[tauri::command]
pub async fn read_qdpx_for_compare(file_path: String) -> CmdResult<Value> {
    let mut data = reader::read_qdpx(Path::new(&file_path), None)?;
    data["filePath"] = file_path.clone().into();
    data["editorInfo"] =
        serde_json::to_value(checkout::read_editor_info(Path::new(&file_path))).unwrap();
    Ok(data)
}

/// Pull one binary out of the comparison file into the ACTIVE project's
/// import overlay; returns its new handle.
#[tauri::command]
pub async fn import_merge_binary(
    state: State<'_, AppState>,
    comparison_file_path: String,
    handle: String,
) -> CmdResult<Option<String>> {
    let Some(name) = archive_file_name_from_handle(&handle) else {
        return Ok(None);
    };
    let Some(bytes) = archive::read_archive_file(&comparison_file_path, &name) else {
        return Ok(None);
    };
    let ext = name.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
    Ok(Some(state.store.put_overlay(bytes, ext)))
}

/// Empty bytes stand for "not available" (the bridge maps them to null).
#[tauri::command]
pub async fn read_compare_binary(
    comparison_file_path: String,
    handle: String,
) -> CmdResult<Response> {
    let bytes = archive_file_name_from_handle(&handle)
        .and_then(|name| archive::read_archive_file(&comparison_file_path, &name));
    Ok(Response::new(bytes.unwrap_or_default()))
}

// ── Save ──

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveData {
    project: Value,
    source_contents: Map<String, Value>,
    file_path: Option<String>,
    current_file_path: Option<String>,
    user_name: Option<String>,
}

fn write(
    app: &AppHandle,
    state: &AppState,
    path: &Path,
    mut data: SaveData,
    carry: Option<&Path>,
    drop_lock: bool,
) -> CmdResult<Option<Value>> {
    let version = app_version(app);
    let editor = storage::editor_name();
    let opts = writer::WriteOptions {
        carry_forward_from: carry,
        store: Some(&state.store),
        drop_lock,
        app_version: &version,
        editor_name: &editor,
    };
    match writer::write_qdpx(path, &mut data.project, &data.source_contents, &opts) {
        Ok(()) => Ok(None),
        Err(writer::WriteError::Guard(m)) => {
            log::warn!("[save guard] {m}");
            Ok(Some(json!({ "guardBlocked": true, "message": m })))
        }
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn save_project(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    data: SaveData,
) -> CmdResult<Value> {
    let path = match data.file_path.as_deref().filter(|p| !p.is_empty()) {
        Some(p) => PathBuf::from(p),
        None => {
            let name = format!(
                "{}.qdpx",
                data.project
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("Untitled")
            );
            match save_dialog(
                &app,
                &window,
                "Save QDPX Project",
                &name,
                ("QDPX Projects", &["qdpx"]),
            ) {
                Some(p) => p,
                None => return Ok(Value::Null),
            }
        }
    };
    // Staleness check: if someone else now holds the checkout lock, refuse
    // the blind overwrite; the renderer routes this into Steal Back.
    if let Some(user) = data.user_name.as_deref().filter(|u| !u.is_empty())
        && let Some(marker) = checkout::read_checkout_marker(&path)
        && marker.user_name != user
    {
        return Ok(json!({ "conflict": true, "marker": marker }));
    }
    if let Some(blocked) = write(&app, &state, &path, data, None, false)? {
        return Ok(blocked);
    }
    // Note (not set): keep the overlay token → guid mappings just recorded.
    state.store.note_active_project_path(Some(&path_str(&path)));
    Ok(path_str(&path).into())
}

#[tauri::command]
pub async fn save_project_as(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    data: SaveData,
) -> CmdResult<Value> {
    let name = format!(
        "{}.qdpx",
        data.project
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("Untitled")
    );
    let Some(path) = save_dialog(
        &app,
        &window,
        "Save QDPX Project As",
        &name,
        ("QDPX Projects", &["qdpx"]),
    ) else {
        return Ok(Value::Null);
    };
    let carry = data.current_file_path.clone().map(PathBuf::from);
    if let Some(blocked) = write(&app, &state, &path, data, carry.as_deref(), false)? {
        return Ok(blocked);
    }
    state.store.note_active_project_path(Some(&path_str(&path)));
    Ok(path_str(&path).into())
}

/// "Create a Copy" from the checkout-conflict dialog: an unattended,
/// unlocked duplicate named "YYMMDD<name> <original>.qdpx".
#[tauri::command]
pub async fn create_project_copy(
    app: AppHandle,
    state: State<'_, AppState>,
    data: SaveData,
) -> CmdResult<Value> {
    let current = PathBuf::from(data.current_file_path.clone().unwrap_or_default());
    let dir = current.parent().map(Path::to_path_buf).unwrap_or_default();
    let base = current
        .file_name()
        .map(|n| n.to_string_lossy().trim_end_matches(".qdpx").to_string())
        .unwrap_or_default();
    let date = chrono::Local::now().format("%y%m%d").to_string();
    let safe: String = data
        .user_name
        .clone()
        .unwrap_or_default()
        .trim()
        .chars()
        .filter(|c| !r#"\/:*?"<>|"#.contains(*c))
        .collect();
    let prefix = if safe.is_empty() {
        date
    } else {
        format!("{date}{safe}")
    };
    let mut candidate = dir.join(format!("{prefix} {base}.qdpx"));
    let mut n = 2;
    while candidate.exists() {
        candidate = dir.join(format!("{prefix} {base} ({n}).qdpx"));
        n += 1;
    }
    if let Some(blocked) = write(&app, &state, &candidate, data, Some(&current), true)? {
        return Ok(blocked);
    }
    state
        .store
        .note_active_project_path(Some(&path_str(&candidate)));
    Ok(path_str(&candidate).into())
}

fn new_project_file(
    app: &AppHandle,
    parent: &WebviewWindow,
) -> CmdResult<Option<(String, String)>> {
    let Some(path) = save_dialog(
        app,
        parent,
        "Create New Project",
        "Untitled.qdpx",
        ("QDPX Projects", &["qdpx"]),
    ) else {
        return Ok(None);
    };
    match writer::create_empty_project_file(&path, &app_version(app), &storage::editor_name()) {
        Ok(name) => Ok(Some((path_str(&path), name))),
        Err(e) => {
            error_box(app, "Failed to create project", &e.to_string());
            Ok(None)
        }
    }
}

#[tauri::command]
pub async fn create_new_project_file(app: AppHandle, window: WebviewWindow) -> CmdResult<Value> {
    Ok(match new_project_file(&app, &window)? {
        Some((file_path, project_name)) => {
            json!({ "filePath": file_path, "projectName": project_name })
        }
        None => Value::Null,
    })
}

fn error_box(app: &AppHandle, title: &str, message: &str) {
    use tauri_plugin_dialog::MessageDialogKind;
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Error)
        .blocking_show();
}

// ── Document import ──

const SUPPORTED: &[&str] = &[
    "txt", "md", "markdown", "pdf", "docx", "rtf", "odt", "doc", "csv", "xlsx", "wav", "mp3",
    "ogg", "flac", "m4a", "aac", "jpg", "jpeg", "png", "gif", "webp", "tif", "tiff", "heic",
    "heif", "mp4", "mov", "avi",
];
const AUDIO: &[&str] = &["wav", "mp3", "ogg", "flac", "m4a", "aac"];
const IMAGE: &[&str] = &["jpg", "jpeg", "png", "gif", "webp"];
/// Accepted but decoded to PNG on import — not displayable everywhere.
const DECODED_IMAGE: &[&str] = &["tif", "tiff", "heic", "heif"];
const VIDEO: &[&str] = &["mp4", "mov", "avi"];

fn audio_mime(ext: &str) -> &'static str {
    match ext {
        "wav" => "audio/wav",
        "mp3" => "audio/mpeg",
        "ogg" => "audio/ogg",
        "flac" => "audio/flac",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        _ => "audio/wav",
    }
}

fn image_mime(ext: &str) -> &'static str {
    match ext {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    }
}

fn video_mime(ext: &str) -> &'static str {
    match ext {
        "mov" => "video/quicktime",
        "avi" => "video/x-msvideo",
        _ => "video/mp4",
    }
}

fn ext_of(name: &str) -> String {
    match name.rfind('.') {
        Some(i) if i > 0 => name[i + 1..].to_lowercase(),
        _ => String::new(),
    }
}

/// A PDF-backed document for the renderer: it extracts the text with pdf.js
/// (`_pendingPdfText`) — the same library its viewer uses, so offsets agree.
fn pdf_doc(name: &str, pdf: &[u8]) -> Value {
    json!({
        "name": name,
        "content": "",
        "extension": "pdf",
        "formatting": { "pdfBase64": base64::engine::general_purpose::STANDARD.encode(pdf), "pdfPageOffsets": [] },
        "_pendingPdfText": true,
    })
}

/// Read one document for import. `bytes` is the file's content (read from
/// disk, or sent by the renderer for an OS drag-and-drop).
fn read_document(
    app: &AppHandle,
    state: &AppState,
    name: &str,
    bytes: Vec<u8>,
) -> CmdResult<Value> {
    let ext = ext_of(name);
    let office_pdf = |html: Result<String, String>| -> CmdResult<Value> {
        let doc = convert::html::print_document(&html?);
        let pdf = print::html_to_pdf(app, &doc, &print::PdfOptions::import())?;
        Ok(pdf_doc(name, &pdf))
    };
    match ext.as_str() {
        "pdf" => Ok(pdf_doc(name, &bytes)),
        "docx" => office_pdf(convert::docx::docx_to_html(&bytes)),
        "rtf" => office_pdf(convert::rtf::rtf_to_html(&bytes)),
        "odt" => office_pdf(convert::odt::odt_to_html(&bytes)),
        "doc" => Err("Legacy Microsoft Word .doc files aren't supported. Please open the file in Word and save it as .docx.".into()),
        // CSV for the survey importer; the extension stays xlsx so the
        // renderer routes it through the survey import.
        "xlsx" => Ok(json!({ "name": name, "content": convert::xlsx::xlsx_to_csv(&bytes)?, "extension": "xlsx" })),
        e if IMAGE.contains(&e) || DECODED_IMAGE.contains(&e) => {
            let (bytes, ext) = match e {
                "tif" | "tiff" => (convert::image::tiff_to_png(&bytes)?, "png".to_string()),
                "heic" | "heif" => (convert::image::heic_to_png(&bytes)?, "png".to_string()),
                _ => (bytes, e.to_string()),
            };
            let mime = image_mime(&ext);
            Ok(json!({
                "name": name, "content": "", "extension": ext,
                "formatting": { "imageFilePath": state.store.put_overlay(bytes, &ext), "mimeType": mime, "imageExt": ext },
            }))
        }
        e if VIDEO.contains(&e) => {
            let duration = convert::media::video_duration(&bytes).unwrap_or(0.0);
            Ok(json!({
                "name": name, "content": "", "extension": e,
                "formatting": { "videoFilePath": state.store.put_overlay(bytes, e), "mimeType": video_mime(e), "duration": duration, "videoExt": e },
            }))
        }
        e if AUDIO.contains(&e) => {
            let meta = convert::media::audio_metadata(&bytes);
            let (duration, channels, rate) = meta.map(|m| (m.duration, m.channels, m.sample_rate)).unwrap_or((0.0, 1, 44100));
            Ok(json!({
                "name": name, "content": "", "extension": e,
                "formatting": {
                    "audioFilePath": state.store.put_overlay(bytes, e), "mimeType": audio_mime(e),
                    "duration": duration, "channels": channels, "sampleRate": rate,
                },
            }))
        }
        _ => Ok(json!({ "name": name, "content": String::from_utf8_lossy(&bytes), "extension": ext })),
    }
}

fn file_name(p: &Path) -> String {
    p.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn read_document_path(app: &AppHandle, state: &AppState, path: &Path) -> Value {
    let name = file_name(path);
    match std::fs::read(path)
        .map_err(|e| e.to_string())
        .and_then(|b| read_document(app, state, &name, b))
    {
        Ok(v) => v,
        Err(e) => json!({ "name": name, "error": e }),
    }
}

/// Why a dropped path can't be imported, if it can't.
fn reject_reason(path: &Path) -> Option<String> {
    if path.is_dir() {
        return Some("Folders can't be imported. Drop the files inside it instead.".into());
    }
    let ext = ext_of(&file_name(path));
    if ext.is_empty() {
        return Some("Files without an extension can't be imported.".into());
    }
    (!SUPPORTED.contains(&ext.as_str())).then(|| format!("Magnolia can't import .{ext} files."))
}

#[tauri::command]
pub async fn import_text_file(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> CmdResult<Value> {
    let project = state.store.active_project_path();
    let mut d =
        dialog(&app, Some(&window), "Import Document").add_filter("Supported Documents", SUPPORTED);
    if let Some(dir) = storage::last_import_dir(project.as_deref()) {
        d = d.set_directory(dir);
    }
    let Some(paths) = d.blocking_pick_files() else {
        return Ok(Value::Null);
    };
    let paths: Vec<PathBuf> = paths.into_iter().filter_map(to_path).collect();
    if let Some(dir) = paths.first().and_then(|p| p.parent()) {
        storage::set_last_import_dir(project.as_deref(), dir);
    }
    Ok(paths
        .iter()
        .map(|p| read_document_path(&app, &state, p))
        .collect::<Vec<_>>()
        .into())
}

/// Real filesystem paths (from a native source rather than a browser drop).
#[tauri::command]
pub async fn read_text_files(
    app: AppHandle,
    state: State<'_, AppState>,
    file_paths: Vec<String>,
) -> CmdResult<Value> {
    Ok(file_paths
        .iter()
        .map(|fp| {
            let p = Path::new(fp);
            match reject_reason(p) {
                Some(r) => json!({ "name": file_name(p), "error": r }),
                None => read_document_path(&app, &state, p),
            }
        })
        .collect::<Vec<_>>()
        .into())
}

/// One file dropped from the OS: the webview has its bytes but not its path,
/// so the renderer sends them as the raw request body with the file name in
/// the `x-file-name` header (URI-encoded).
#[tauri::command]
pub async fn read_dropped_file(
    app: AppHandle,
    state: State<'_, AppState>,
    request: Request<'_>,
) -> CmdResult<Value> {
    let name = request
        .headers()
        .get("x-file-name")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| urlencoding::decode(v).ok())
        .map(|s| s.into_owned())
        .unwrap_or_default();
    let ext = ext_of(&name);
    if ext.is_empty() {
        return Ok(
            json!({ "name": name, "error": "Files without an extension can't be imported." }),
        );
    }
    if !SUPPORTED.contains(&ext.as_str()) {
        return Ok(
            json!({ "name": name, "error": format!("Magnolia can't import .{ext} files.") }),
        );
    }
    let bytes = match request.body() {
        InvokeBody::Raw(b) => b.clone(),
        InvokeBody::Json(_) => return Err("expected raw file bytes".into()),
    };
    Ok(match read_document(&app, &state, &name, bytes) {
        Ok(v) => v,
        Err(e) => json!({ "name": name, "error": e }),
    })
}

/// Re-attach a file to an existing document whose bytes are missing from
/// the project; the result honours the SOURCE's media type.
#[tauri::command]
pub async fn reimport_document(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    source_type: String,
) -> CmdResult<Value> {
    let exts: Vec<&str> = match source_type.as_str() {
        "pdf" => vec!["pdf", "docx", "rtf", "odt"],
        "image" => IMAGE.iter().chain(DECODED_IMAGE).copied().collect(),
        // Audio and video share containers (Atlas references video as .m4a).
        "audio" | "video" => AUDIO.iter().chain(VIDEO).copied().collect(),
        _ => SUPPORTED.to_vec(),
    };
    let project = state.store.active_project_path();
    let mut d =
        dialog(&app, Some(&window), "Re-import Document").add_filter("Supported Documents", &exts);
    if let Some(dir) = storage::last_import_dir(project.as_deref()) {
        d = d.set_directory(dir);
    }
    let Some(path) = d.blocking_pick_file().and_then(to_path) else {
        return Ok(Value::Null);
    };
    if let Some(dir) = path.parent() {
        storage::set_last_import_dir(project.as_deref(), dir);
    }
    let mut doc = read_document_path(&app, &state, &path);
    if let Some(f) = doc.get("formatting").cloned() {
        let handle = f
            .get("videoFilePath")
            .or_else(|| f.get("audioFilePath"))
            .cloned();
        let ext = doc.get("extension").cloned();
        let num = |k: &str, d: Value| f.get(k).cloned().unwrap_or(d);
        if source_type == "video" && handle.is_some() && f.get("videoFilePath").is_none() {
            doc["formatting"] = json!({ "videoFilePath": handle, "mimeType": "video/mp4", "duration": num("duration", 0.into()), "videoExt": ext });
        } else if source_type == "audio" && handle.is_some() && f.get("audioFilePath").is_none() {
            doc["formatting"] = json!({
                "audioFilePath": handle, "mimeType": "audio/mp4", "duration": num("duration", 0.into()),
                "channels": num("channels", 1.into()), "sampleRate": num("sampleRate", 44100.into()),
            });
        }
    }
    Ok(doc)
}

#[tauri::command]
pub async fn import_transcript(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> CmdResult<Value> {
    let project = state.store.active_project_path();
    let mut d = dialog(&app, Some(&window), "Import Transcript").add_filter(
        "Text Files",
        &["txt", "md", "markdown", "srt", "vtt", "html", "htm"],
    );
    if let Some(dir) = storage::last_import_dir(project.as_deref()) {
        d = d.set_directory(dir);
    }
    let Some(path) = d.blocking_pick_file().and_then(to_path) else {
        return Ok(Value::Null);
    };
    if let Some(dir) = path.parent() {
        storage::set_last_import_dir(project.as_deref(), dir);
    }
    let content = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(json!({ "name": file_name(&path), "content": String::from_utf8_lossy(&content) }))
}

// ── Export ──

#[tauri::command]
pub async fn export_pdf(
    app: AppHandle,
    window: WebviewWindow,
    html: String,
    default_name: String,
    dialog_title: Option<String>,
    header_template: Option<String>,
    footer_template: Option<String>,
) -> CmdResult<Option<String>> {
    let title = dialog_title.unwrap_or_else(|| "Export as PDF".into());
    let Some(path) = save_dialog(
        &app,
        &window,
        &title,
        &format!("{default_name}.pdf"),
        ("PDF Documents", &["pdf"]),
    ) else {
        return Ok(None);
    };
    let opts = print::PdfOptions::export(
        &storage::paper_size(),
        header_template.as_deref(),
        footer_template.as_deref(),
    );
    let pdf = print::html_to_pdf(&app, &html, &opts)?;
    std::fs::write(&path, pdf).map_err(|e| e.to_string())?;
    Ok(Some(path_str(&path)))
}

async fn export_text(
    app: &AppHandle,
    window: &WebviewWindow,
    content: &str,
    default_name: &str,
    filter: (&str, &[&str]),
) -> CmdResult<Option<String>> {
    let Some(path) = save_dialog(app, window, "Export", default_name, filter) else {
        return Ok(None);
    };
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(Some(path_str(&path)))
}

#[tauri::command]
pub async fn export_csv(
    app: AppHandle,
    window: WebviewWindow,
    content: String,
    default_name: String,
) -> CmdResult<Option<String>> {
    export_text(&app, &window, &content, &default_name, ("CSV", &["csv"])).await
}

#[tauri::command]
pub async fn export_svg(
    app: AppHandle,
    window: WebviewWindow,
    content: String,
    default_name: String,
) -> CmdResult<Option<String>> {
    export_text(&app, &window, &content, &default_name, ("SVG", &["svg"])).await
}

#[tauri::command]
pub async fn export_codebook(
    app: AppHandle,
    window: WebviewWindow,
    codes: Vec<Value>,
) -> CmdResult<Option<String>> {
    let xml = codebook::serialize_codebook(&codes, &app_version(&app));
    let Some(path) = save_dialog(
        &app,
        &window,
        "Export Codebook",
        "Codebook.qdc",
        ("REFI-QDA Codebook", &["qdc"]),
    ) else {
        return Ok(None);
    };
    std::fs::write(&path, xml).map_err(|e| e.to_string())?;
    Ok(Some(path_str(&path)))
}

#[tauri::command]
pub async fn import_codebook(
    app: AppHandle,
    window: WebviewWindow,
) -> CmdResult<Option<Vec<Value>>> {
    let Some(path) = dialog(&app, Some(&window), "Import Codebook")
        .add_filter("REFI-QDA Codebook", &["qdc"])
        .blocking_pick_file()
        .and_then(to_path)
    else {
        return Ok(None);
    };
    let xml = std::fs::read(&path).map_err(|e| e.to_string())?;
    codebook::deserialize_codebook(&String::from_utf8_lossy(&xml)).map(Some)
}

// ── Bundled licence files ──

/// Open LICENSE / THIRD-PARTY-LICENSES.txt in the OS's default viewer:
/// bundled resources when packaged, the repo root in development.
pub fn open_bundled_file(app: &AppHandle, name: &str) {
    use tauri_plugin_opener::OpenerExt;
    let mut candidates = vec![];
    if let Ok(res) = app.path().resource_dir() {
        candidates.push(res.join(name));
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(name),
    );
    if let Some(found) = candidates.into_iter().find(|p| p.exists()) {
        let _ = app.opener().open_path(path_str(&found), None::<&str>);
    }
}

#[tauri::command]
pub async fn open_licence(app: AppHandle) -> CmdResult<()> {
    open_bundled_file(&app, "LICENSE");
    Ok(())
}

#[tauri::command]
pub async fn open_acknowledgements(app: AppHandle) -> CmdResult<()> {
    open_bundled_file(&app, "THIRD-PARTY-LICENSES.txt");
    Ok(())
}

// ── Windows ──

#[tauri::command]
pub async fn open_child_window(app: AppHandle, kind: String, data: Value) -> CmdResult<()> {
    match kind.as_str() {
        "codebook" => windows::open_codebook(&app, data),
        "logbook" => windows::open_logbook(&app, data),
        "memo-edit" => windows::open_memo(&app, data),
        "query-results" => windows::open_query_results(&app, data),
        _ => return Err(format!("unknown window kind {kind}")),
    }
    Ok(())
}

#[tauri::command]
pub async fn update_query_results_window(app: AppHandle, data: Value) -> CmdResult<()> {
    windows::update_query_results(&app, data);
    Ok(())
}

#[tauri::command]
pub async fn get_window_data(app: AppHandle, window: WebviewWindow) -> CmdResult<Value> {
    Ok(windows::window_data(&app, window.label()))
}

#[tauri::command]
pub async fn drain_queued_events(
    app: AppHandle,
    window: WebviewWindow,
    event: String,
) -> CmdResult<Vec<Value>> {
    Ok(windows::drain_queued(&app, window.label(), &event))
}

#[tauri::command]
pub async fn focus_main_window(app: AppHandle) -> CmdResult<()> {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.set_focus();
    }
    Ok(())
}

#[tauri::command]
pub async fn raise_other_windows(app: AppHandle, window: WebviewWindow) -> CmdResult<()> {
    windows::raise_other_windows(&app, window.label());
    Ok(())
}

#[tauri::command]
pub async fn update_panel_visibility(
    app: AppHandle,
    state: State<'_, AppState>,
    visibility: Value,
) -> CmdResult<()> {
    state.ui.lock().unwrap().panel_visibility = Some(visibility);
    crate::menu::rebuild(&app);
    Ok(())
}

#[tauri::command]
pub async fn flush_complete(app: AppHandle) -> CmdResult<()> {
    windows::flush_complete(&app);
    Ok(())
}

#[tauri::command]
pub async fn flush_heartbeat(app: AppHandle) -> CmdResult<()> {
    windows::arm_flush_watchdog(&app);
    Ok(())
}

/// Keep the menu's window list in step with renamed windows.
#[tauri::command]
pub async fn window_title_changed(app: AppHandle) -> CmdResult<()> {
    crate::menu::rebuild(&app);
    Ok(())
}

// ── Welcome screen ──

#[tauri::command]
pub async fn get_recent_projects() -> CmdResult<Vec<Value>> {
    Ok(storage::prune_recent_projects())
}

#[tauri::command]
pub async fn track_recent_project(name: String, file_path: String) -> CmdResult<()> {
    storage::track_recent_project(&name, &file_path);
    Ok(())
}

#[tauri::command]
pub async fn welcome_action(
    app: AppHandle,
    window: WebviewWindow,
    action: String,
) -> CmdResult<()> {
    use tauri_plugin_opener::OpenerExt;
    match action.as_str() {
        "quit" => windows::quit(&app),
        "sponsor" => {
            let _ = app
                .opener()
                .open_url("https://github.com/sponsors/caledavis", None::<&str>);
        }
        "new-project" => {
            if let Some((file_path, project_name)) = new_project_file(&app, &window)? {
                storage::track_recent_project(&project_name, &file_path);
                if windows::open_main(&app).is_some() {
                    windows::emit_when_ready(
                        &app,
                        MAIN,
                        "new-project-at-path",
                        json!({ "filePath": file_path, "projectName": project_name }),
                    );
                }
            }
        }
        "open-project" => {
            if let Some(path) = pick_qdpx(&app, Some(&window)) {
                // Validate before leaving the welcome screen.
                match reader::read_qdpx(Path::new(&path), None) {
                    Ok(_) => windows::open_project_in_main(&app, &path),
                    Err(e) => error_box(&app, "Failed to open project", &e),
                }
            }
        }
        "clear-recent" => storage::clear_recent_projects(),
        a if a.starts_with("open-recent:") => {
            let path = &a["open-recent:".len()..];
            if !Path::new(path).exists() {
                storage::remove_recent_project(path);
                windows::emit_to(&app, window.label(), "recent-projects-changed", ());
                error_box(
                    &app,
                    "Project not found",
                    &format!(
                        "\"{path}\" no longer exists. It has been removed from Recent Projects."
                    ),
                );
            } else {
                windows::open_project_in_main(&app, path);
            }
        }
        _ => {}
    }
    Ok(())
}

// ── Preferences ──

#[tauri::command]
pub async fn load_preferences() -> CmdResult<Value> {
    Ok(storage::load_preferences())
}

#[tauri::command]
pub async fn save_preferences(prefs: Value) -> CmdResult<()> {
    storage::save_preferences(&prefs);
    Ok(())
}

/// Persist and echo to the main window so its preferences store re-syncs.
#[tauri::command]
pub async fn preferences_update(app: AppHandle, prefs: Value) -> CmdResult<()> {
    storage::save_preferences(&prefs);
    windows::emit_to(&app, MAIN, "preferences-update", prefs);
    Ok(())
}

#[tauri::command]
pub async fn get_app_version(app: AppHandle) -> CmdResult<String> {
    Ok(app_version(&app))
}
