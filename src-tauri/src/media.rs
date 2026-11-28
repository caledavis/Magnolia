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
use tauri::http::{HeaderValue, Request, Response, StatusCode, header};
use tauri::ipc::Response as IpcResponse;
use tauri::{AppHandle, Manager, State, UriSchemeResponder};

pub const SCHEME: &str = "magnolia-media";

/// Most bytes sent for one range request: the player asks for the rest.
const MAX_RANGE: u64 = 4 << 20;

fn locate(state: &AppState, handle: &str, archive_path: Option<&str>) -> Option<MediaSource> {
    crate::commands::note_archive(state, archive_path);
    // A legacy real path is read in place only if the user chose that
    // file; otherwise the store finds the copy saved in the project.
    state.store.locate(handle, crate::access::is_granted(handle))
}

/// Answer a request on its own thread: reading the file mustn't hold up
/// the event loop.
pub fn handle(app: &AppHandle, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let app = app.clone();
    std::thread::spawn(move || responder.respond(serve(&app, &request)));
}

fn empty(status: StatusCode) -> Response<Cow<'static, [u8]>> {
    secured(Response::builder())
        .status(status)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(Cow::Borrowed(&[][..]))
        .unwrap()
}

/// Headers every media answer carries. The bytes come from a project
/// someone may have shared: the browser mustn't guess they're a page
/// (nosniff), and if one is ever opened as a page anyway, it runs and
/// loads nothing (sandbox, default-src 'none').
fn secured(b: tauri::http::response::Builder) -> tauri::http::response::Builder {
    b.header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CONTENT_SECURITY_POLICY, "sandbox; default-src 'none'")
}

/// The Content-Type to answer with: the player's `type=`, if it's audio or
/// video and a valid header, else one from the file's extension. Anything
/// else (text/html, say) could have the bytes treated as a page, and a
/// value that isn't a valid header made building the answer panic.
fn content_type(requested: Option<&str>, handle: &str) -> HeaderValue {
    requested
        .filter(|t| {
            let t = t.to_ascii_lowercase();
            t.starts_with("audio/") || t.starts_with("video/")
        })
        .and_then(|t| HeaderValue::from_str(t).ok())
        .unwrap_or_else(|| HeaderValue::from_static(mime_for(handle)))
}

/// How to answer a request: a whole response, or bytes `start..=end` of
/// `source` (`len` bytes long) as a 206 with `head`'s headers.
enum Answer {
    Done(Response<Cow<'static, [u8]>>),
    Range {
        head: tauri::http::response::Builder,
        source: MediaSource,
        handle: String,
        start: u64,
        end: u64,
        len: u64,
    },
}

fn answer(app: &AppHandle, request: &Request<Vec<u8>>) -> Answer {
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
        return Answer::Done(empty(StatusCode::NOT_FOUND));
    };
    let len = source.len();
    let mime = content_type(param("type").as_deref(), &handle);
    let builder = secured(Response::builder())
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::ACCESS_CONTROL_EXPOSE_HEADERS, "content-range, content-length");
    if request.method() == tauri::http::Method::HEAD {
        return Answer::Done(builder.header(header::CONTENT_LENGTH, len).body(Cow::Borrowed(&[][..])).unwrap());
    }
    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(|r| parse_range(r, len));
    let (start, end) = match range {
        Some(Some(r)) => r,
        Some(None) => {
            return Answer::Done(
                secured(Response::builder())
                    .status(StatusCode::RANGE_NOT_SATISFIABLE)
                    .header(header::CONTENT_RANGE, format!("bytes */{len}"))
                    .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                    .body(Cow::Borrowed(&[][..]))
                    .unwrap(),
            );
        }
        // No Range header: the whole file, as a partial response.
        None => (0, len.saturating_sub(1)),
    };
    Answer::Range { head: builder, source, handle, start, end, len }
}

/// The `magnolia-media://` answer, all in memory, so at most `MAX_RANGE`
/// bytes of it: the player asks for the rest.
fn serve(app: &AppHandle, request: &Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    match answer(app, request) {
        Answer::Done(r) => r,
        Answer::Range { head, source, handle, start, end, len } => {
            let end = end.min(start + MAX_RANGE - 1);
            match source.read(start, end + 1) {
                Ok(bytes) => partial(head, start, end, len).header(header::CONTENT_LENGTH, bytes.len()).body(Cow::Owned(bytes)).unwrap(),
                Err(e) => {
                    log::warn!("could not stream {handle}: {e}");
                    empty(StatusCode::INTERNAL_SERVER_ERROR)
                }
            }
        }
    }
}

fn partial(head: tauri::http::response::Builder, start: u64, end: u64, len: u64) -> tauri::http::response::Builder {
    head.status(StatusCode::PARTIAL_CONTENT)
        .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
}

/// Linux: the players can't use `magnolia-media://`. WebKitGTK plays media
/// through GStreamer, whose source reads only http(s) and blob: URLs, so
/// every recording failed to load ("format not supported") whatever its
/// codecs. There the same answers are served over HTTP on the loopback
/// interface, at a random secret path, so no other program can read
/// through it without that secret. The players get the address from
/// `window.__MAGNOLIA_MEDIA_BASE__` (set in every window, windows.rs).
#[cfg(target_os = "linux")]
pub mod http {
    use super::{Answer, answer, partial, secured};
    use std::borrow::Cow;
    use std::sync::OnceLock;
    use tauri::AppHandle;
    use tauri::http::{Request, Response};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    static BASE: OnceLock<Option<String>> = OnceLock::new();

    /// `http://127.0.0.1:<port>/<secret>`, starting the server the first
    /// time it's asked for. `None` if it couldn't listen.
    pub fn base_url(app: &AppHandle) -> Option<&'static str> {
        BASE.get_or_init(|| start(app)).as_deref()
    }

    fn start(app: &AppHandle) -> Option<String> {
        let listener = std::net::TcpListener::bind("127.0.0.1:0")
            .and_then(|l| l.set_nonblocking(true).map(|_| l))
            .inspect_err(|e| log::warn!("media: couldn't listen: {e}"))
            .ok()?;
        let port = listener.local_addr().ok()?.port();
        let secret = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
        let (app, prefix) = (app.clone(), format!("/{secret}/"));
        tauri::async_runtime::spawn(async move {
            let Ok(server) = tokio::net::TcpListener::from_std(listener) else { return };
            loop {
                let Ok((sock, peer)) = server.accept().await else { continue };
                if !peer.ip().is_loopback() {
                    continue;
                }
                let (app, prefix) = (app.clone(), prefix.clone());
                tauri::async_runtime::spawn(async move {
                    let _ = connection(app, sock, &prefix).await;
                });
            }
        });
        Some(format!("http://127.0.0.1:{port}/{secret}"))
    }

    /// Bytes read from the file at a time: what a response holds in memory.
    const CHUNK: u64 = 1 << 20;

    /// One request, one response, then close: each seek opens its own. A
    /// range is sent whole, a piece at a time: GStreamer takes a shorter
    /// answer for the end of the file, so the 4 MB answers the custom
    /// protocol gives stopped every longer recording a few seconds in.
    async fn connection(app: AppHandle, mut sock: tokio::net::TcpStream, prefix: &str) -> std::io::Result<()> {
        let mut head = Vec::new();
        let mut buf = [0u8; 4096];
        while !head.windows(4).any(|w| w == b"\r\n\r\n") {
            let n = tokio::time::timeout(std::time::Duration::from_secs(10), sock.read(&mut buf))
                .await
                .map_err(|_| std::io::ErrorKind::TimedOut)??;
            if n == 0 || head.len() > 16 * 1024 {
                return Ok(());
            }
            head.extend_from_slice(&buf[..n]);
        }
        let answer = match parse(&head, prefix) {
            Some(request) if request.method() == tauri::http::Method::OPTIONS => Answer::Done(preflight()),
            Some(request) => tauri::async_runtime::spawn_blocking(move || answer(&app, &request))
                .await
                .unwrap_or_else(|_| Answer::Done(status_only(500))),
            None => Answer::Done(status_only(404)),
        };
        match answer {
            Answer::Done(response) => {
                sock.write_all(&response_head(&response)).await?;
                sock.write_all(response.body()).await?;
            }
            Answer::Range { head, source, handle, start, end, len } => {
                let response = partial(head, start, end, len)
                    .header(tauri::http::header::CONTENT_LENGTH, end + 1 - start)
                    .body(Cow::Borrowed(&[][..]))
                    .unwrap();
                sock.write_all(&response_head(&response)).await?;
                let mut at = start;
                while at <= end {
                    let stop = (at + CHUNK).min(end + 1);
                    let piece = source.clone();
                    let bytes = tauri::async_runtime::spawn_blocking(move || piece.read(at, stop))
                        .await
                        .map_err(std::io::Error::other)?
                        .inspect_err(|e| log::warn!("could not stream {handle}: {e}"))?;
                    // The player closes the connection when it seeks: stop.
                    sock.write_all(&bytes).await?;
                    at = stop;
                }
            }
        }
        sock.shutdown().await
    }

    /// The request, as the media protocol sees it, if it carries the secret.
    pub(super) fn parse(head: &[u8], prefix: &str) -> Option<Request<Vec<u8>>> {
        let text = std::str::from_utf8(head).ok()?;
        let mut lines = text.split("\r\n");
        let mut first = lines.next()?.split(' ');
        let (method, target) = (first.next()?, first.next()?);
        let rest = target.strip_prefix(prefix)?;
        let mut b = Request::builder()
            .method(method)
            .uri(format!("{}://localhost/{rest}", super::SCHEME));
        for line in lines.take_while(|l| !l.is_empty()) {
            if let Some((name, value)) = line.split_once(':') {
                b = b.header(name.trim(), value.trim());
            }
        }
        b.body(Vec::new()).ok()
    }

    fn preflight() -> Response<Cow<'static, [u8]>> {
        secured(Response::builder())
            .status(204)
            .header("Access-Control-Allow-Origin", "*")
            .header("Access-Control-Allow-Headers", "range")
            .body(Cow::Borrowed(&[][..]))
            .unwrap()
    }

    fn status_only(status: u16) -> Response<Cow<'static, [u8]>> {
        secured(Response::builder()).status(status).body(Cow::Borrowed(&[][..])).unwrap()
    }

    pub(super) fn response_head(r: &Response<Cow<'static, [u8]>>) -> Vec<u8> {
        let status = r.status();
        let mut out = format!("HTTP/1.1 {} {}\r\n", status.as_u16(), status.canonical_reason().unwrap_or(""));
        for (name, value) in r.headers() {
            if name != tauri::http::header::CONTENT_LENGTH {
                out.push_str(&format!("{name}: {}\r\n", value.to_str().unwrap_or("")));
            }
        }
        // HEAD answers say how long the file is, without the bytes.
        let length = r
            .headers()
            .get(tauri::http::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
            .unwrap_or_else(|| r.body().len().to_string());
        out.push_str(&format!("Content-Length: {length}\r\nConnection: close\r\n\r\n"));
        out.into_bytes()
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
    use super::{content_type, parse_range};

    #[test]
    fn only_audio_or_video_types_are_answered() {
        assert_eq!(content_type(Some("video/mp4"), "x.mov"), "video/mp4");
        assert_eq!(content_type(Some("Audio/MPEG"), "x.wav"), "Audio/MPEG");
        // Not media: from the extension instead.
        assert_eq!(content_type(Some("text/html"), "x.mov"), "video/quicktime");
        assert_eq!(content_type(Some("image/svg+xml"), "x.bin"), "application/octet-stream");
        assert_eq!(content_type(None, "a/b.m4a"), "audio/mp4");
        assert_eq!(content_type(Some(""), "a/b.m4a"), "audio/mp4");
        // Not a valid header value: no panic, the extension's type.
        assert_eq!(content_type(Some("video/mp4\r\nSet-Cookie: x"), "x.mp4"), "video/mp4");
        assert_eq!(content_type(Some("video/\u{7f}"), "x.mp3"), "audio/mpeg");
    }

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

    #[test]
    #[cfg(target_os = "linux")]
    fn http_requests_need_the_secret() {
        use super::http::parse;
        let head = b"GET /s3cret/%2Fa%2Fb.mp4?type=video%2Fmp4 HTTP/1.1\r\nHost: 127.0.0.1\r\nRange: bytes=0-99\r\n\r\n";
        let request = parse(head, "/s3cret/").unwrap();
        assert_eq!(request.uri().to_string(), "magnolia-media://localhost/%2Fa%2Fb.mp4?type=video%2Fmp4");
        assert_eq!(request.headers()["range"], "bytes=0-99");
        assert!(parse(head, "/other/").is_none());
        assert!(parse(b"GET /%2Fa%2Fb.mp4 HTTP/1.1\r\n\r\n", "/s3cret/").is_none());
    }
}
