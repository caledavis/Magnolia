//! Reading the user's Zotero library through the Zotero app's local API
//! (Zotero 7 and later, http://localhost:23119/api/, read-only). The user
//! turns it on in Zotero's settings; Magnolia only ever sends GET requests
//! to this computer. The renderer works out what to ask for
//! (utils/zotero.ts); these commands carry the requests and turn an
//! attachment into a path that the normal import can read.

use serde_json::{Value, json};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::time::Duration;

const PORT: u16 = 23119;

/// Said when nothing answers on Zotero's port: Zotero isn't open.
const NOT_RUNNING: &str = "zotero-not-running";

struct Reply {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
}

impl Reply {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

/// Only paths under /api/, with nothing that could end the request line.
fn valid_path(path: &str) -> bool {
    path.starts_with("/api/") && !path.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// One GET to Zotero on this computer.
fn get(path: &str) -> Result<Reply, String> {
    if !valid_path(path) {
        return Err(format!("not a Zotero API path: {path}"));
    }
    let addr = SocketAddr::from(([127, 0, 0, 1], PORT));
    let mut stream =
        TcpStream::connect_timeout(&addr, Duration::from_secs(2)).map_err(|_| NOT_RUNNING.to_string())?;
    stream.set_read_timeout(Some(Duration::from_secs(60))).ok();
    stream.set_write_timeout(Some(Duration::from_secs(10))).ok();
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: localhost:{PORT}\r\nAccept: application/json\r\nZotero-API-Version: 3\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).map_err(|e| e.to_string())?;
    parse_reply(&raw)
}

fn parse_reply(raw: &[u8]) -> Result<Reply, String> {
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or("Zotero sent an incomplete reply")?;
    let head = String::from_utf8_lossy(&raw[..split]);
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or("Zotero sent an unreadable reply")?;
    let headers: Vec<(String, String)> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
        .collect();
    let mut body = raw[split + 4..].to_vec();
    let chunked = headers
        .iter()
        .any(|(k, v)| k.eq_ignore_ascii_case("transfer-encoding") && v.eq_ignore_ascii_case("chunked"));
    if chunked {
        body = dechunk(&body);
    }
    Ok(Reply { status, headers, body: String::from_utf8_lossy(&body).into_owned() })
}

fn dechunk(mut data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    while let Some(eol) = data.windows(2).position(|w| w == b"\r\n") {
        let size_text = String::from_utf8_lossy(&data[..eol]);
        let size = usize::from_str_radix(size_text.split(';').next().unwrap_or("").trim(), 16).unwrap_or(0);
        data = &data[eol + 2..];
        if size == 0 || size > data.len() {
            break;
        }
        out.extend_from_slice(&data[..size]);
        data = data.get(size + 2..).unwrap_or(&[]);
    }
    out
}

/// A file:// URL as a path on this computer.
fn file_url_to_path(url: &str) -> Option<PathBuf> {
    let rest = url.trim().strip_prefix("file://")?;
    let rest = rest.strip_prefix("localhost").unwrap_or(rest);
    let decoded = urlencoding::decode(rest).ok()?.into_owned();
    // file:///C:/Users/… on Windows
    let bytes = decoded.as_bytes();
    if cfg!(windows) && bytes.len() > 2 && bytes[0] == b'/' && bytes[2] == b':' {
        return Some(PathBuf::from(&decoded[1..]));
    }
    Some(PathBuf::from(decoded))
}

/// GET a Zotero API path. Answers `{ status, total, body }` (`total` from
/// the Total-Results header of a list), or fails with
/// "zotero-not-running" when Zotero isn't open.
#[tauri::command]
pub async fn zotero_get(path: String) -> Result<Value, String> {
    let reply = tauri::async_runtime::spawn_blocking(move || get(&path))
        .await
        .map_err(|e| e.to_string())??;
    let total = reply.header("Total-Results").and_then(|v| v.parse::<u64>().ok());
    Ok(json!({ "status": reply.status, "total": total, "body": reply.body }))
}

/// Where an attachment's file is on this computer, or null if Zotero has
/// none (a link to a web page, or a file that was never downloaded).
/// `library` is "users/0" or "groups/<id>".
#[tauri::command]
pub async fn zotero_file_path(library: String, key: String) -> Result<Option<String>, String> {
    let ok_part = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '/');
    if !ok_part(&library) || !ok_part(&key) {
        return Err("not a Zotero item".into());
    }
    let path = format!("/api/{library}/items/{key}/file/view/url");
    let reply = tauri::async_runtime::spawn_blocking(move || get(&path))
        .await
        .map_err(|e| e.to_string())??;
    if reply.status != 200 {
        return Ok(None);
    }
    Ok(file_url_to_path(&reply.body)
        .filter(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_api_paths() {
        assert!(valid_path("/api/users/0/items/top?limit=100&start=0"));
        assert!(!valid_path("/connector/saveItems"));
        assert!(!valid_path("/api/x HTTP/1.1\r\nHost: evil"));
    }

    #[test]
    fn reads_a_reply() {
        let raw = b"HTTP/1.0 200 OK\r\nTotal-Results: 2\r\nContent-Type: application/json\r\n\r\n[1,2]";
        let r = parse_reply(raw).unwrap();
        assert_eq!(r.status, 200);
        assert_eq!(r.header("total-results"), Some("2"));
        assert_eq!(r.body, "[1,2]");
    }

    #[test]
    fn reads_a_chunked_reply() {
        let raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n";
        assert_eq!(parse_reply(raw).unwrap().body, "abcde");
    }

    #[test]
    fn turns_file_urls_into_paths() {
        assert_eq!(
            file_url_to_path("file:///Users/me/Zotero/storage/AB12/My%20Paper.pdf"),
            Some(PathBuf::from("/Users/me/Zotero/storage/AB12/My Paper.pdf"))
        );
        assert_eq!(file_url_to_path("https://example.org/x.pdf"), None);
    }
}
