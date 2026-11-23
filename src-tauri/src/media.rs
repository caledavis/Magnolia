//! Streaming audio and video to the page a piece at a time, instead of
//! handing it the whole file: a long recording is a gigabyte or more, and
//! copying all of it into the page stalled the app before anything played.
//!
//! - The players load `magnolia-media://localhost/<handle>?project=<path>`
//!   (optionally `&type=<mime>`), answered in byte ranges as they play and
//!   seek.
//! - The waveform reads the parts of the file it needs through
//!   `media_size` and `read_media_range`.

use crate::state::AppState;
use magnolia_core::binary_store::MediaSource;
use std::borrow::Cow;
use tauri::http::{Request, Response, StatusCode, header};
use tauri::ipc::Response as IpcResponse;
use tauri::{AppHandle, Manager, State, UriSchemeResponder};

pub const SCHEME: &str = "magnolia-media";

/// Most bytes sent for one range request: the player asks for the rest.
const MAX_RANGE: u64 = 4 << 20;

fn locate(state: &AppState, handle: &str, archive_path: Option<&str>) -> Option<MediaSource> {
    state.store.note_active_project_path(archive_path);
    state.store.locate(handle)
}

/// Answer a request on its own thread: reading the file mustn't hold up
/// the event loop.
pub fn handle(app: &AppHandle, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let app = app.clone();
    std::thread::spawn(move || responder.respond(serve(&app, &request)));
}

fn serve(app: &AppHandle, request: &Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let empty = |status: StatusCode| {
        Response::builder()
            .status(status)
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(Cow::Borrowed(&[][..]))
            .unwrap()
    };
    let uri = request.uri();
    let handle = urlencoding::decode(uri.path().trim_start_matches('/'))
        .map(|s| s.into_owned())
        .unwrap_or_default();
    let param = |key: &str| {
        uri.query()?
            .split('&')
            .find_map(|kv| kv.strip_prefix(key)?.strip_prefix('='))
            // URLSearchParams writes spaces as '+'.
            .and_then(|v| urlencoding::decode(&v.replace('+', " ")).ok().map(|s| s.into_owned()))
    };
    let project = param("project");
    let Some(source) = locate(app.state::<AppState>().inner(), &handle, project.as_deref()) else {
        return empty(StatusCode::NOT_FOUND);
    };
    let len = source.len();
    let mime = param("type")
        .filter(|t| !t.is_empty() && !t.contains(['\r', '\n']))
        .unwrap_or_else(|| mime_for(&handle).to_string());
    let builder = Response::builder()
        .header(header::CONTENT_TYPE, mime.as_str())
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::ACCESS_CONTROL_EXPOSE_HEADERS, "content-range, content-length");
    if request.method() == tauri::http::Method::HEAD {
        return builder
            .header(header::CONTENT_LENGTH, len)
            .body(Cow::Borrowed(&[][..]))
            .unwrap();
    }
    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(|r| parse_range(r, len));
    let (start, end) = match range {
        Some(Some(r)) => r,
        Some(None) => {
            return Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{len}"))
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(Cow::Borrowed(&[][..]))
                .unwrap();
        }
        // No Range header: the start of the file, as a partial response,
        // so nothing ever asks for a whole recording in one go.
        None => (0, len.saturating_sub(1)),
    };
    let end = end.min(start + MAX_RANGE - 1);
    match source.read(start, end + 1) {
        Ok(bytes) => builder
            .status(StatusCode::PARTIAL_CONTENT)
            .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
            .header(header::CONTENT_LENGTH, bytes.len())
            .body(Cow::Owned(bytes))
            .unwrap(),
        Err(e) => {
            log::warn!("could not stream {handle}: {e}");
            empty(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

/// A single `bytes=` range as inclusive (start, end), or `None` if it
/// can't be satisfied. Of several ranges, only the first is answered.
fn parse_range(header: &str, len: u64) -> Option<(u64, u64)> {
    let spec = header.trim().strip_prefix("bytes=")?.split(',').next()?.trim();
    let (from, to) = spec.split_once('-')?;
    if len == 0 {
        return None;
    }
    let (start, end) = if from.is_empty() {
        let suffix: u64 = to.parse().ok()?;
        (len.saturating_sub(suffix), len - 1)
    } else {
        let start: u64 = from.parse().ok()?;
        let end = if to.is_empty() { len - 1 } else { to.parse::<u64>().ok()?.min(len - 1) };
        (start, end)
    };
    (start <= end && start < len).then_some((start, end))
}

fn mime_for(handle: &str) -> &'static str {
    let ext = handle.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "avi" => "video/x-msvideo",
        "mkv" => "video/x-matroska",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "flac" => "audio/flac",
        _ => "application/octet-stream",
    }
}

/// A media binary's length in bytes.
#[tauri::command]
pub async fn media_size(
    state: State<'_, AppState>,
    handle: String,
    archive_path: Option<String>,
) -> Result<u64, String> {
    locate(&state, &handle, archive_path.as_deref())
        .map(|s| s.len())
        .ok_or_else(|| format!("ENOENT: binary not available: {handle}"))
}

/// Bytes `start..end` of a media binary.
#[tauri::command]
pub async fn read_media_range(
    state: State<'_, AppState>,
    handle: String,
    start: u64,
    end: u64,
    archive_path: Option<String>,
) -> Result<IpcResponse, String> {
    let source = locate(&state, &handle, archive_path.as_deref())
        .ok_or_else(|| format!("ENOENT: binary not available: {handle}"))?;
    source
        .read(start, end)
        .map(IpcResponse::new)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::parse_range;

    #[test]
    fn ranges() {
        assert_eq!(parse_range("bytes=0-", 100), Some((0, 99)));
        assert_eq!(parse_range("bytes=10-19", 100), Some((10, 19)));
        assert_eq!(parse_range("bytes=90-200", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=-10", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=0-1", 100), Some((0, 1)));
        assert_eq!(parse_range("bytes=100-", 100), None);
        assert_eq!(parse_range("bytes=5-2", 100), None);
        assert_eq!(parse_range("items=0-1", 100), None);
    }
}
