//! IPC commands invoked by the renderer's `window.api` bridge
//! (src/renderer/platform/tauri-api.ts).
//!
//! Every command is `async`, so Tauri runs it off the main thread: project
//! reads and writes can take a while on large projects, and native dialogs
//! opened with the plugin's blocking API must not block the event loop.

use crate::access;
use crate::print;
use crate::state::AppState;
use crate::i18n::{t, t_with};
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

/// Dialog filters that match an extension in any case.
trait Filter {
    fn filter(self, name: impl Into<String>, extensions: &[&str]) -> Self;
}

impl Filter for FileDialogBuilder<tauri::Wry> {
    fn filter(self, name: impl Into<String>, extensions: &[&str]) -> Self {
        let patterns = dialog_patterns(extensions);
        let patterns: Vec<&str> = patterns.iter().map(String::as_str).collect();
        self.add_filter(name, &patterns)
    }
}

/// GTK matches a filter's `*.jpg` case-sensitively, so on Linux a camera's
/// IMG_0001.JPG (or a phone's CLIP.MP4) didn't show in Import or Open at
/// all. There each letter becomes a bracket of both cases (`*.[jJ][pP][gG]`),
/// which GTK's patterns understand. macOS and Windows ignore case already.
fn dialog_patterns(extensions: &[&str]) -> Vec<String> {
    if !cfg!(target_os = "linux") {
        return extensions.iter().map(|e| e.to_string()).collect();
    }
    extensions
        .iter()
        .map(|e| {
            e.chars()
                .map(|c| {
                    let (lo, up) = (c.to_ascii_lowercase(), c.to_ascii_uppercase());
                    if lo == up { c.to_string() } else { format!("[{lo}{up}]") }
                })
                .collect()
        })
        .collect()
}

fn to_path(p: tauri_plugin_dialog::FilePath) -> Option<PathBuf> {
    p.into_path().ok()
}

pub fn pick_qdpx(app: &AppHandle, parent: Option<&WebviewWindow>) -> Option<String> {
    let path = dialog(app, parent, &t("dialog.openProject"))
        .filter(t("dialog.qdpxProjects"), &["qdpx"])
        .blocking_pick_file()
        .and_then(to_path)?;
    access::grant(&path);
    Some(path.to_string_lossy().into_owned())
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
        .filter(filter.0, filter.1)
        .blocking_save_file()
        .and_then(to_path)?;
    // GTK doesn't append the filter's extension.
    if path.extension().is_none()
        && let Some(ext) = filter.1.first()
    {
        path.set_extension(ext);
    }
    access::grant(&path);
    Some(path)
}

fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

// ── Project open / read ──

fn load_project(window: &WebviewWindow, state: &AppState, path: &str) -> CmdResult<Value> {
    access::check_project(path)?;
    // Opened, so it's the user's project: theirs to save, too.
    access::grant(path);
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

/// Several project files at once, for comparing coders' projects.
#[tauri::command]
pub async fn pick_project_files(app: AppHandle, window: WebviewWindow) -> CmdResult<Vec<String>> {
    Ok(dialog(&app, Some(&window), &t("dialog.openProject"))
        .filter(t("dialog.qdpxProjects"), &["qdpx"])
        .blocking_pick_files()
        .unwrap_or_default()
        .into_iter()
        .filter_map(to_path)
        .inspect(|p| access::grant(p))
        .map(|p| p.to_string_lossy().into_owned())
        .collect())
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
    if let Some(p) = file_path.as_deref().filter(|p| !p.is_empty()) {
        access::check_granted(p)?;
    }
    state.store.set_active_project_path(file_path.as_deref());
    Ok(())
}

#[tauri::command]
pub async fn get_file_size(file_path: String) -> CmdResult<Option<u64>> {
    access::check_granted(&file_path)?;
    Ok(std::fs::metadata(file_path).ok().map(|m| m.len()))
}

/// The archive a media read names, if it's a project the user opened.
pub(crate) fn note_archive(state: &AppState, archive_path: Option<&str>) {
    if let Some(p) = archive_path.filter(|p| access::is_granted(p)) {
        state.store.note_active_project_path(Some(p));
    }
}

/// Media bytes for a viewer: a `magnolia-bin://` handle, or a legacy real
/// path (self-healed from the archive if the temp copy was reaped).
#[tauri::command]
pub async fn read_media(
    state: State<'_, AppState>,
    handle: String,
    archive_path: Option<String>,
) -> CmdResult<Response> {
    note_archive(&state, archive_path.as_deref());
    if is_binary_handle(&handle) {
        return state
            .store
            .resolve(&handle)
            .map(|b| Response::new(b.as_ref().clone()))
            .ok_or_else(|| format!("ENOENT: binary not available: {handle}"));
    }
    // A legacy real path: read it only if the user chose that file;
    // otherwise (and if it's gone) take the copy saved in the project.
    if access::is_granted(&handle)
        && let Ok(b) = std::fs::read(&handle)
    {
        return Ok(Response::new(b));
    }
    let name = Path::new(&handle)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    state
        .store
        .read_archive_by_name(&name)
        .map(Response::new)
        .ok_or_else(|| format!("ENOENT: {handle}"))
}

// ── Check-out / check-in ──

#[tauri::command]
pub async fn read_checkout_marker(
    file_path: String,
) -> CmdResult<Option<checkout::CheckoutMarker>> {
    access::check_project(&file_path)?;
    Ok(checkout::read_checkout_marker(Path::new(&file_path)))
}

#[tauri::command]
pub async fn check_out_project(
    file_path: String,
    user_name: String,
    steal: Option<bool>,
) -> CmdResult<checkout::CheckoutWriteResult> {
    access::check_granted(&file_path)?;
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
    access::check_granted(&file_path)?;
    checkout::write_checkout_marker(
        Path::new(&file_path),
        &user_name,
        checkout::CheckoutAction::CheckIn,
    )
    .map_err(|e| e.to_string())
}

// ── Merge ──

/// The given files that no longer exist (moved, renamed or deleted), so
/// a saved Inter-coder analysis can warn that a coder's project is missing.
#[tauri::command]
pub async fn missing_files(paths: Vec<String>) -> CmdResult<Vec<String>> {
    Ok(paths.into_iter().filter(|p| !Path::new(p).is_file()).collect())
}

/// Load a second .qdpx for comparison without touching the active project.
#[tauri::command]
pub async fn read_qdpx_for_compare(file_path: String) -> CmdResult<Value> {
    access::check_project(&file_path)?;
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
    access::check_project(&comparison_file_path)?;
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
    access::check_project(&comparison_file_path)?;
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
    /// The user emptied the project themselves (renderer
    /// stores/empty-save-guard), so the writer's empty-project guards
    /// stand down.
    #[serde(default)]
    allow_empty: bool,
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
        allow_empty: data.allow_empty,
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
        Some(p) => {
            access::check_granted(p)?;
            PathBuf::from(p)
        }
        None => {
            let name = format!(
                "{}.qdpx",
                data.project
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| t("dialog.untitled"))
            );
            match save_dialog(
                &app,
                &window,
                &t("dialog.saveProject"),
                &name,
                (&t("dialog.qdpxProjects"), &["qdpx"]),
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
            .map(str::to_string)
            .unwrap_or_else(|| t("dialog.untitled"))
    );
    let Some(path) = save_dialog(
        &app,
        &window,
        &t("dialog.saveProjectAs"),
        &name,
        (&t("dialog.qdpxProjects"), &["qdpx"]),
    ) else {
        return Ok(Value::Null);
    };
    let carry = data.current_file_path.clone().map(PathBuf::from);
    if let Some(c) = &carry {
        access::check_project(c)?;
    }
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
    access::check_granted(&current)?;
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
    access::grant(&candidate);
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
        &t("dialog.createProject"),
        &format!("{}.qdpx", t("dialog.untitled")),
        (&t("dialog.qdpxProjects"), &["qdpx"]),
    ) else {
        return Ok(None);
    };
    match writer::create_empty_project_file(&path, &app_version(app), &storage::editor_name()) {
        Ok(name) => Ok(Some((path_str(&path), name))),
        Err(e) => {
            error_box(app, &t("dialog.createProjectFailed"), &e.to_string());
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

/// The project's latest changes couldn't be saved (`error` says why, or
/// `locked_by` names who now has control), and it's about to be replaced
/// by another project, or closed (`closing`): ask whether to go ahead and
/// lose them. True to go ahead.
#[tauri::command]
pub async fn confirm_losing_changes(
    app: AppHandle,
    window: WebviewWindow,
    name: String,
    error: Option<String>,
    locked_by: Option<String>,
    closing: bool,
) -> bool {
    use tauri_plugin_dialog::{MessageDialogButtons, MessageDialogKind};
    let error = match locked_by {
        Some(who) => t_with("dialog.unsavedLockedBy", &[("name", &who)]),
        None => error.unwrap_or_default(),
    };
    let (message, go) = if closing {
        ("dialog.unsavedMessageClose", "dialog.closeAnyway")
    } else {
        ("dialog.unsavedMessage", "dialog.openAnyway")
    };
    app.dialog()
        .message(t_with(message, &[("name", &name), ("error", &error)]))
        .title(t("dialog.unsavedTitle"))
        .kind(MessageDialogKind::Warning)
        .parent(&window)
        .buttons(MessageDialogButtons::OkCancelCustom(t(go), t("dialog.cancel")))
        .blocking_show()
}

/// A native message dialog over `window`, for the page: `window.alert`
/// and `window.confirm` show nothing in the webview (Tauri's dialog plugin
/// swaps them for calls the app's capabilities don't allow, and its
/// `confirm` answers with a Promise, which reads as yes). The first
/// paragraph is the dialog's bold title, the rest its explanation.
fn page_dialog(
    app: &AppHandle,
    window: &WebviewWindow,
    message: &str,
    kind: Option<&str>,
) -> tauri_plugin_dialog::MessageDialogBuilder<tauri::Wry> {
    use tauri_plugin_dialog::MessageDialogKind;
    let (title, detail) = message.split_once("\n\n").unwrap_or((message, ""));
    let kind = match kind {
        Some("error") => MessageDialogKind::Error,
        Some("warning") => MessageDialogKind::Warning,
        _ => MessageDialogKind::Info,
    };
    app.dialog().message(detail).title(title).kind(kind).parent(window)
}

/// Show a message (`kind`: "info", "warning" or "error") and wait for OK.
#[tauri::command]
pub async fn show_message(app: AppHandle, window: WebviewWindow, message: String, kind: Option<String>) {
    page_dialog(&app, &window, &message, kind.as_deref()).blocking_show();
}

/// Ask a yes-or-no question; true if the first button (`ok_label`) was chosen.
#[tauri::command]
pub async fn ask_confirm(
    app: AppHandle,
    window: WebviewWindow,
    message: String,
    ok_label: String,
    cancel_label: String,
) -> bool {
    use tauri_plugin_dialog::MessageDialogButtons;
    page_dialog(&app, &window, &message, Some("warning"))
        .buttons(MessageDialogButtons::OkCancelCustom(ok_label, cancel_label))
        .blocking_show()
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

/// A PDF-backed document for the renderer: it reads the text with pdf.js
/// (`_pendingPdfText`), or from the PDF's own text layer when Magnolia
/// typeset it — the same reading its viewer uses, so offsets agree.
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
    state: &AppState,
    name: &str,
    bytes: Vec<u8>,
) -> CmdResult<Value> {
    let ext = ext_of(name);
    // Office documents are typeset as PDFs that carry their own text layer
    // (convert::typeset), so their text reads back exactly in any script.
    let office_pdf = |html: Result<String, String>| -> CmdResult<Value> {
        let pdf = convert::typeset::html_to_pdf(&html?)?;
        Ok(pdf_doc(name, &pdf))
    };
    match ext.as_str() {
        "pdf" => Ok(pdf_doc(name, &bytes)),
        "docx" => office_pdf(convert::docx::docx_to_html(&bytes)),
        "rtf" => office_pdf(convert::rtf::rtf_to_html(&bytes)),
        "odt" => office_pdf(convert::odt::odt_to_html(&bytes)),
        "doc" => Err(t("import.legacyDoc")),
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
            let duration = convert::media::video_duration(&bytes);
            Ok(video_doc(name, e, state.store.put_overlay(bytes, e), duration))
        }
        e if AUDIO.contains(&e) => {
            let meta = convert::media::audio_metadata(&bytes);
            Ok(audio_doc(name, e, state.store.put_overlay(bytes, e), meta))
        }
        _ => Ok(json!({ "name": name, "content": String::from_utf8_lossy(&bytes), "extension": ext })),
    }
}

fn file_name(p: &Path) -> String {
    p.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn video_doc(name: &str, ext: &str, handle: String, duration: Option<f64>) -> Value {
    json!({
        "name": name, "content": "", "extension": ext,
        "formatting": { "videoFilePath": handle, "mimeType": video_mime(ext), "duration": duration.unwrap_or(0.0), "videoExt": ext },
    })
}

fn audio_doc(name: &str, ext: &str, handle: String, meta: Option<convert::media::AudioMetadata>) -> Value {
    let (duration, channels, rate) = meta.map(|m| (m.duration, m.channels, m.sample_rate)).unwrap_or((0.0, 1, 44100));
    json!({
        "name": name, "content": "", "extension": ext,
        "formatting": {
            "audioFilePath": handle, "mimeType": audio_mime(ext),
            "duration": duration, "channels": channels, "sampleRate": rate,
        },
    })
}

/// Audio or video from disk: copied to the store as a file and its details
/// read from the file, so a long recording is never loaded into memory.
fn read_media_path(state: &AppState, name: &str, path: &Path, ext: &str) -> CmdResult<Value> {
    let handle = state.store.put_overlay_file(path, ext).map_err(|e| {
        log::warn!("could not read {}: {e}", path.display());
        t("import.unreadable")
    })?;
    Ok(if VIDEO.contains(&ext) {
        video_doc(name, ext, handle, convert::media::video_duration_file(path))
    } else {
        audio_doc(name, ext, handle, convert::media::audio_metadata_file(path))
    })
}

fn read_document_path(state: &AppState, path: &Path) -> Value {
    let name = file_name(path);
    let ext = ext_of(&name);
    if VIDEO.contains(&ext.as_str()) || AUDIO.contains(&ext.as_str()) {
        return read_media_path(state, &name, path, &ext)
            .unwrap_or_else(|e| json!({ "name": name, "error": e }));
    }
    match std::fs::read(path)
        .map_err(|e| {
            log::warn!("could not read {}: {e}", path.display());
            t("import.unreadable")
        })
        .and_then(|b| read_document(state, &name, b))
    {
        Ok(v) => v,
        Err(e) => json!({ "name": name, "error": e }),
    }
}

/// Why a dropped path can't be imported, if it can't.
fn reject_reason(path: &Path) -> Option<String> {
    if path.is_dir() {
        return Some(t("import.folder"));
    }
    let ext = ext_of(&file_name(path));
    if ext.is_empty() {
        return Some(t("import.noExtension"));
    }
    (!SUPPORTED.contains(&ext.as_str())).then(|| t_with("import.unsupported", &[("ext", &ext)]))
}

/// Ask for documents to import. Returns their paths (null if cancelled);
/// the renderer reads them one at a time with `read_text_files`, so it can
/// show how the import is going.
#[tauri::command]
pub async fn pick_import_files(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> CmdResult<Value> {
    let project = state.store.active_project_path();
    let mut d =
        dialog(&app, Some(&window), &t("dialog.importDocument")).filter(t("dialog.supportedDocuments"), SUPPORTED);
    if let Some(dir) = storage::last_import_dir(project.as_deref()) {
        d = d.set_directory(dir);
    }
    let Some(paths) = d.blocking_pick_files() else {
        return Ok(Value::Null);
    };
    let paths: Vec<PathBuf> = paths.into_iter().filter_map(to_path).collect();
    paths.iter().for_each(access::grant);
    if let Some(dir) = paths.first().and_then(|p| p.parent()) {
        storage::set_last_import_dir(project.as_deref(), dir);
    }
    Ok(paths
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .into())
}

/// Real filesystem paths (from a native source rather than a browser drop).
#[tauri::command]
pub async fn read_text_files(
    state: State<'_, AppState>,
    file_paths: Vec<String>,
) -> CmdResult<Value> {
    Ok(file_paths
        .iter()
        .map(|fp| {
            let p = Path::new(fp);
            if let Err(e) = access::check_granted(p) {
                return json!({ "name": file_name(p), "error": e });
            }
            match reject_reason(p) {
                Some(r) => json!({ "name": file_name(p), "error": r }),
                None => read_document_path(&state, p),
            }
        })
        .collect::<Vec<_>>()
        .into())
}

/// Where a file dropped on the page lives on disk, if that can be found, so
/// the import reads it from there (`read_text_files`) rather than having
/// the page read it into memory and send it over IPC — for a long video
/// that copied a gigabyte or more several times over and stalled the app.
/// The webview hides dropped files' paths, but on macOS the drag pasteboard
/// still holds them, and on Linux the drag's data did (linux.rs); the one
/// with this name and size is the file.
#[tauri::command]
pub fn dropped_file_path(name: String, size: u64) -> Option<String> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        #[cfg(target_os = "macos")]
        let dragged = drag_pasteboard_paths();
        #[cfg(target_os = "linux")]
        let dragged = crate::linux::dragged_paths();
        dragged.into_iter().find_map(|p| {
            let same = p.file_name().is_some_and(|n| n.to_string_lossy() == name)
                && std::fs::metadata(&p).is_ok_and(|m| m.is_file() && m.len() == size);
            // The user dragged it here: theirs to import.
            same.then(|| {
                access::grant(&p);
                p.to_string_lossy().into_owned()
            })
        })
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = (name, size);
        None
    }
}

/// The file paths on the pasteboard of the most recent drag.
#[cfg(target_os = "macos")]
fn drag_pasteboard_paths() -> Vec<PathBuf> {
    use objc2::ClassType;
    use objc2_app_kit::{NSPasteboard, NSPasteboardNameDrag};
    use objc2_foundation::{NSArray, NSURL};
    // SAFETY: plain pasteboard reads; the names are AppKit constants.
    unsafe {
        let pb = NSPasteboard::pasteboardWithName(NSPasteboardNameDrag);
        let classes = NSArray::from_slice(&[NSURL::class()]);
        let Some(items) = pb.readObjectsForClasses_options(&classes, None) else {
            return Vec::new();
        };
        items
            .iter()
            .filter_map(|item| {
                let url = item.downcast_ref::<NSURL>()?;
                if !url.isFileURL() {
                    return None;
                }
                // Resolves file reference URLs (file:///.file/id=…).
                Some(PathBuf::from(url.filePathURL()?.path()?.to_string()))
            })
            .collect()
    }
}

/// One file dropped from the OS: the webview has its bytes but not its path,
/// so the renderer sends them as the raw request body with the file name in
/// the `x-file-name` header (URI-encoded).
#[tauri::command]
pub async fn read_dropped_file(
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
            json!({ "name": name, "error": t("import.noExtension") }),
        );
    }
    if !SUPPORTED.contains(&ext.as_str()) {
        return Ok(
            json!({ "name": name, "error": t_with("import.unsupported", &[("ext", &ext)]) }),
        );
    }
    let bytes = match request.body() {
        InvokeBody::Raw(b) => b.clone(),
        InvokeBody::Json(_) => return Err("expected raw file bytes".into()),
    };
    Ok(match read_document(&state, &name, bytes) {
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
        dialog(&app, Some(&window), &t("dialog.reimportDocument")).filter(t("dialog.supportedDocuments"), &exts);
    if let Some(dir) = storage::last_import_dir(project.as_deref()) {
        d = d.set_directory(dir);
    }
    let Some(path) = d.blocking_pick_file().and_then(to_path) else {
        return Ok(Value::Null);
    };
    if let Some(dir) = path.parent() {
        storage::set_last_import_dir(project.as_deref(), dir);
    }
    let mut doc = read_document_path(&state, &path);
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
    let mut d = dialog(&app, Some(&window), &t("dialog.importTranscript")).filter(
        t("dialog.textFiles"),
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
// The page passes each of these by name; bundling them would only move the list.
#[allow(clippy::too_many_arguments)]
pub async fn export_pdf(
    app: AppHandle,
    window: WebviewWindow,
    html: String,
    default_name: String,
    dialog_title: Option<String>,
    header_template: Option<String>,
    footer_template: Option<String>,
    script: Option<String>,
) -> CmdResult<Option<String>> {
    let title = dialog_title.unwrap_or_else(|| t("dialog.exportPdf"));
    let file_name = format!("{default_name}.pdf");
    let Some(path) = crate::automation::export_path(&file_name)
        .or_else(|| save_dialog(&app, &window, &title, &file_name, ("PDF Documents", &["pdf"])))
    else {
        return Ok(None);
    };
    let opts = print::PdfOptions::export(
        &storage::paper_size(),
        header_template.as_deref(),
        footer_template.as_deref(),
    );
    let pdf = print::html_to_pdf(&app, &html, script.as_deref(), &opts)?;
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
    let Some(path) = crate::automation::export_path(default_name)
        .or_else(|| save_dialog(app, window, &t("dialog.export"), default_name, filter))
    else {
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
    export_text(&app, &window, &with_bom(&content), &default_name, ("CSV", &["csv"])).await
}

/// CSV text with a UTF-8 byte-order mark in front, which Excel needs to
/// read it as UTF-8: without one it guesses the system's legacy encoding
/// and garbles anything beyond Latin letters (Arabic, Chinese, Cyrillic).
/// Other spreadsheets, R and pandas all accept the mark.
fn with_bom(content: &str) -> String {
    if content.starts_with('\u{FEFF}') {
        content.to_string()
    } else {
        format!("\u{FEFF}{content}")
    }
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
        &t("dialog.exportCodebook"),
        &format!("{}.qdc", t("dialog.codebookFileName")),
        (&t("dialog.qdcCodebook"), &["qdc"]),
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
    let Some(path) = dialog(&app, Some(&window), &t("dialog.importCodebook"))
        .filter(t("dialog.qdcCodebook"), &["qdc"])
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
        "memos" => windows::open_memos(&app, data),
        "memo-edit" => windows::open_memo(&app, data),
        "query-results" => windows::open_query_results(&app, data),
        "intercoder-results" => windows::open_intercoder_results(&app, data),
        _ => return Err(format!("unknown window kind {kind}")),
    }
    Ok(())
}

/// Whether Query Results was popped out when the main window last closed.
#[tauri::command]
pub fn query_results_popped_out() -> bool {
    storage::query_results_popped_out()
}

#[tauri::command]
pub async fn update_query_results_window(app: AppHandle, data: Value) -> CmdResult<()> {
    windows::update_query_results(&app, data);
    Ok(())
}

#[tauri::command]
pub async fn update_intercoder_results_window(app: AppHandle, data: Value) -> CmdResult<()> {
    windows::update_intercoder_results(&app, data);
    Ok(())
}

#[tauri::command]
pub async fn close_child_window(app: AppHandle, kind: String) -> CmdResult<()> {
    match kind.as_str() {
        "intercoder-results" => windows::close_child(&app, windows::INTERCODER_RESULTS),
        _ => return Err(format!("unknown window kind {kind}")),
    }
    Ok(())
}

#[tauri::command]
pub async fn update_memos_window(app: AppHandle, data: Value) -> CmdResult<()> {
    windows::update_memos(&app, data);
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
    crate::menu::rebuild_if_changed(&app);
    Ok(())
}

#[tauri::command]
pub async fn flush_complete(app: AppHandle) -> CmdResult<()> {
    windows::flush_complete(&app);
    Ok(())
}

/// The renderer couldn't save before closing and was told to stay open:
/// the close (or quit) is off.
#[tauri::command]
pub async fn flush_cancelled(app: AppHandle) -> CmdResult<()> {
    windows::flush_cancelled(&app);
    Ok(())
}

#[tauri::command]
pub async fn flush_heartbeat(app: AppHandle) -> CmdResult<()> {
    windows::arm_flush_watchdog(&app);
    Ok(())
}

/// Keep the menu's window list in step with renamed windows. A title change
/// also resets the traffic lights on macOS.
#[tauri::command]
pub async fn window_title_changed(app: AppHandle, window: tauri::WebviewWindow) -> CmdResult<()> {
    crate::windows::place_traffic_lights(&window);
    crate::menu::rebuild_if_changed(&app);
    Ok(())
}

// ── Welcome screen ──

#[tauri::command]
pub async fn get_recent_projects() -> CmdResult<Vec<Value>> {
    Ok(storage::prune_recent_projects())
}

#[tauri::command]
pub async fn track_recent_project(name: String, file_path: String) -> CmdResult<()> {
    access::check_granted(&file_path)?;
    storage::track_recent_project(&name, &file_path);
    Ok(())
}

/// Open a web or mail link in the system's default handler. The webview
/// can't: `window.open` and `target="_blank"` links make no new window in
/// Tauri, so they did nothing (the ribbon's Manual and Donate buttons).
#[tauri::command]
pub fn open_external(app: AppHandle, url: String) -> CmdResult<()> {
    use tauri_plugin_opener::OpenerExt;
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("mailto:") {
        let _ = app.opener().open_url(url, None::<&str>);
    }
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
                    Err(e) => error_box(&app, &t("dialog.openProjectFailed"), &e),
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
                    &t("dialog.projectNotFound"),
                    &t_with("dialog.projectNotFoundMessage", &[("path", path)]),
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

#[cfg(test)]
mod csv_tests {
    #[test]
    fn csv_starts_with_one_bom() {
        assert_eq!(super::with_bom("a,b"), "\u{FEFF}a,b");
        assert_eq!(super::with_bom("\u{FEFF}a,b"), "\u{FEFF}a,b");
    }
}

#[cfg(test)]
mod dialog_tests {
    #[test]
    #[cfg(target_os = "linux")]
    fn linux_filters_match_any_case() {
        assert_eq!(super::dialog_patterns(&["jpg", "mp4"]), ["[jJ][pP][gG]", "[mM][pP]4"]);
    }
}

/// What a bug report needs to know about where Magnolia runs (Help → Copy
/// Diagnostic Information): its version, the system's, the web view's, and
/// the open project file's size. Nothing from the project itself.
#[tauri::command]
pub fn diagnostics_info(app: AppHandle, file_path: Option<String>) -> Value {
    let project_bytes = file_path
        .as_deref()
        .and_then(|p| std::fs::metadata(p).ok())
        .map(|m| m.len());
    serde_json::json!({
        "appVersion": app.package_info().version.to_string(),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "osVersion": os_version(),
        "webview": tauri::webview_version().ok(),
        "projectFileBytes": project_bytes,
    })
}

/// The system's own name for its version ("15.2", "Windows 11 …",
/// "Ubuntu 22.04.4 LTS"), if it can be read.
fn os_version() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("sw_vers").arg("-productVersion").output().ok()?;
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string()).filter(|s| !s.is_empty())
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let out = std::process::Command::new("cmd").args(["/c", "ver"]).creation_flags(CREATE_NO_WINDOW).output().ok()?;
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string()).filter(|s| !s.is_empty())
    }
    #[cfg(target_os = "linux")]
    {
        let text = std::fs::read_to_string("/etc/os-release").ok()?;
        text.lines()
            .find_map(|l| l.strip_prefix("PRETTY_NAME="))
            .map(|v| v.trim_matches('"').to_string())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        None
    }
}
