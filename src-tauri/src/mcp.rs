//! AI apps on this computer (Claude Desktop and others that speak the
//! Model Context Protocol) using Magnolia: the same tools AI Assistance's
//! own chat has, so someone with a Claude subscription can use it instead
//! of an API key.
//!
//! Two halves:
//! - **The connector** (`magnolia --mcp`): the AI app starts it and talks
//!   MCP to it over stdin and stdout. It holds no project: each tool call
//!   goes on to the Magnolia that's open, through…
//! - **…the listener** in Magnolia, on 127.0.0.1 only, started when the user
//!   allows AI apps in Preferences. Its port and a random token are in
//!   `mcp.json` in Magnolia's data folder (readable only by this user), and
//!   a call without the token is refused. The window answers each call
//!   (utils/ai/mcp.ts) as it answers its own chat's: only for a project the
//!   user has turned AI apps on for, listing each call in the AI Assistance
//!   pane, and with every change only proposed, for the AI Assistance
//!   Viewer.

use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

/// The tools, shared with the window's own chat.
const TOOL_SPECS: &str = include_str!("../../src/renderer/utils/ai/tool-specs.json");

/// Where Magnolia's listener is (in its data folder).
const ENDPOINT_FILE: &str = "mcp.json";

/// How long a call may take (a long document read, or a busy window).
const CALL_TIMEOUT: Duration = Duration::from_secs(120);

const INSTRUCTIONS: &str = "Magnolia is a program for qualitative data analysis; these tools work on the project open in it. \
Read with list_documents and list_codes first, then read_document, search_text and coded_passages, reading only what a question needs. \
You cannot change the project: propose_new_code, propose_code_change, propose_coding and propose_remove_coding only make suggestions, which the researcher approves or denies in Magnolia's AI Assistance Viewer; say so, and never claim a change has been made. \
Quote passages exactly as they are in the document when proposing codings, with a short reason for each, and prefer the project's existing codes. \
Ground claims in quoted passages; don't invent quotes or numbers. The researcher decides what the data means.";

// ─── The listener, in Magnolia ───────────────────────────────────────

struct Listener {
    task: tauri::async_runtime::JoinHandle<()>,
}

fn listener() -> &'static Mutex<Option<Listener>> {
    static L: OnceLock<Mutex<Option<Listener>>> = OnceLock::new();
    L.get_or_init(Default::default)
}

/// Calls waiting for the window's answer.
fn waiting() -> &'static Mutex<HashMap<String, tokio::sync::oneshot::Sender<Value>>> {
    static W: OnceLock<Mutex<HashMap<String, tokio::sync::oneshot::Sender<Value>>>> = OnceLock::new();
    W.get_or_init(Default::default)
}

fn endpoint_path() -> PathBuf {
    crate::storage::user_data_dir().join(ENDPOINT_FILE)
}

fn random_token() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

/// Start listening (if not already), or stop.
pub fn set_enabled(app: &AppHandle, on: bool) {
    let mut l = listener().lock().unwrap();
    if !on {
        if let Some(old) = l.take() {
            old.task.abort();
        }
        let _ = std::fs::remove_file(endpoint_path());
        return;
    }
    if l.is_some() {
        return;
    }
    let std_listener = match std::net::TcpListener::bind("127.0.0.1:0") {
        Ok(s) => s,
        Err(e) => {
            log::warn!("AI apps: couldn't listen: {e}");
            return;
        }
    };
    let _ = std_listener.set_nonblocking(true);
    let port = std_listener.local_addr().map(|a| a.port()).unwrap_or(0);
    let token = random_token();
    if write_endpoint(port, &token).is_err() {
        log::warn!("AI apps: couldn't write {ENDPOINT_FILE}");
        return;
    }
    let app = app.clone();
    let tok = token;
    let task = tauri::async_runtime::spawn(async move {
        let Ok(server) = tokio::net::TcpListener::from_std(std_listener) else { return };
        loop {
            let Ok((sock, peer)) = server.accept().await else { continue };
            if !peer.ip().is_loopback() {
                continue;
            }
            let app = app.clone();
            let tok = tok.clone();
            tauri::async_runtime::spawn(async move { serve(app, sock, &tok).await });
        }
    });
    *l = Some(Listener { task });
}

fn write_endpoint(port: u16, token: &str) -> std::io::Result<()> {
    let path = endpoint_path();
    let body = json!({ "port": port, "token": token }).to_string();
    let tmp = path.with_extension("json.tmp");
    {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp)?;
        f.write_all(body.as_bytes())?;
    }
    std::fs::rename(tmp, path)
}

/// One connection: one call, one answer (each a line of JSON).
async fn serve(app: AppHandle, sock: tokio::net::TcpStream, token: &str) {
    let (read, mut write) = sock.into_split();
    let mut lines = tokio::io::BufReader::new(read).lines();
    let Ok(Ok(Some(line))) = tokio::time::timeout(Duration::from_secs(10), lines.next_line()).await else { return };
    let reply = match serde_json::from_str::<Value>(&line) {
        Ok(req) if same(req["token"].as_str().unwrap_or(""), token) => call_window(&app, req).await,
        _ => json!({ "content": "Refused.", "isError": true }),
    };
    let _ = write.write_all(format!("{reply}\n").as_bytes()).await;
}

/// Comparing the token, in time that doesn't depend on where it differs.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

async fn call_window(app: &AppHandle, req: Value) -> Value {
    let Some(window) = app.get_webview_window(crate::windows::MAIN) else {
        return json!({ "content": "Magnolia has no project window open.", "isError": true });
    };
    let call_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = tokio::sync::oneshot::channel();
    waiting().lock().unwrap().insert(call_id.clone(), tx);
    let event = json!({
        "callId": call_id,
        "session": req["session"],
        "client": req["client"],
        "name": req["name"],
        "input": req["input"],
    });
    let _ = tauri::Emitter::emit(&window, "mcp-call", event);
    match tokio::time::timeout(CALL_TIMEOUT, rx).await {
        Ok(Ok(answer)) => answer,
        _ => {
            waiting().lock().unwrap().remove(&call_id);
            json!({ "content": "Magnolia didn't answer in time.", "isError": true })
        }
    }
}

/// The window's answer to a call.
#[tauri::command]
pub async fn mcp_reply(call_id: String, content: String, is_error: bool) {
    if let Some(tx) = waiting().lock().unwrap().remove(&call_id) {
        let _ = tx.send(json!({ "content": content, "isError": is_error }));
    }
}

/// Preferences: allow AI apps on this computer, or stop.
#[tauri::command]
pub async fn mcp_set_enabled(app: AppHandle, enabled: bool) {
    set_enabled(&app, enabled);
}

/// The command an AI app runs to start the connector.
fn connector_command() -> Result<String, String> {
    std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).map_err(|e| e.to_string())
}

/// What to put in an AI app's settings, for the user to copy.
#[tauri::command]
pub async fn mcp_connector_settings() -> Result<Value, String> {
    Ok(json!({ "mcpServers": { "magnolia": { "command": connector_command()?, "args": ["--mcp"] } } }))
}

/// Claude Desktop's settings file, where it has one.
fn claude_desktop_config() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    return dirs::home_dir().map(|h| h.join("Library/Application Support/Claude/claude_desktop_config.json"));
    #[cfg(target_os = "windows")]
    return dirs::config_dir().map(|d| d.join("Claude").join("claude_desktop_config.json"));
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    return None;
}

/// Add Magnolia to Claude Desktop's settings (keeping everything else in
/// them, and a copy of them as they were). Returns the file changed.
#[tauri::command]
pub async fn mcp_add_to_claude_desktop() -> Result<String, String> {
    let path = claude_desktop_config().ok_or("noClaudeDesktop")?;
    let dir = path.parent().ok_or("noClaudeDesktop")?;
    if !dir.exists() {
        return Err("noClaudeDesktop".into());
    }
    let mut config: Value = match std::fs::read_to_string(&path) {
        Ok(text) if !text.trim().is_empty() => {
            serde_json::from_str(&text).map_err(|_| "badClaudeSettings".to_string())?
        }
        _ => json!({}),
    };
    if !config.is_object() {
        return Err("badClaudeSettings".into());
    }
    if path.exists() {
        let _ = std::fs::copy(&path, path.with_extension("json.before-magnolia"));
    }
    if !config["mcpServers"].is_object() {
        config["mcpServers"] = json!({});
    }
    config["mcpServers"]["magnolia"] = json!({ "command": connector_command()?, "args": ["--mcp"] });
    let text = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Whether Claude Desktop is on this computer (its settings folder exists).
#[tauri::command]
pub async fn mcp_claude_desktop_found() -> bool {
    claude_desktop_config().and_then(|p| p.parent().map(|d| d.exists())).unwrap_or(false)
}

// ─── The connector, started by the AI app ────────────────────────────

/// Magnolia's data folder, without the app running (as storage::init
/// finds it).
fn data_dir() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("MAGNOLIA_MCP_DIR") {
        return Some(d.into());
    }
    dirs::config_dir().map(|d| d.join("Magnolia"))
}

/// Run as the connector: MCP over stdin/stdout until the AI app closes it.
pub fn run_connector() {
    let session = uuid::Uuid::new_v4().to_string();
    let mut client = String::from("An AI app");
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(msg) = serde_json::from_str::<Value>(&line) else {
            let _ = writeln!(stdout, "{}", json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "Parse error" } }));
            let _ = stdout.flush();
            continue;
        };
        if let Some(reply) = handle(&msg, &session, &mut client) {
            let _ = writeln!(stdout, "{reply}");
            let _ = stdout.flush();
        }
    }
}

/// One MCP message; a reply unless it was a notification.
fn handle(msg: &Value, session: &str, client: &mut String) -> Option<Value> {
    let id = msg.get("id")?.clone();
    let method = msg["method"].as_str().unwrap_or("");
    let result = match method {
        "initialize" => {
            if let Some(name) = msg["params"]["clientInfo"]["name"].as_str() {
                *client = name.to_string();
            }
            let version = msg["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18");
            json!({
                "protocolVersion": version,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "magnolia", "title": "Magnolia", "version": env!("CARGO_PKG_VERSION") },
                "instructions": INSTRUCTIONS,
            })
        }
        "ping" => json!({}),
        "tools/list" => json!({ "tools": tools() }),
        "tools/call" => {
            let name = msg["params"]["name"].as_str().unwrap_or("");
            let input = msg["params"].get("arguments").cloned().unwrap_or_else(|| json!({}));
            let answer = forward(session, client, name, &input);
            json!({
                "content": [{ "type": "text", "text": answer["content"].as_str().unwrap_or("") }],
                "isError": answer["isError"].as_bool().unwrap_or(false),
            })
        }
        _ => return Some(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": format!("No method {method}") } })),
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

fn tools() -> Vec<Value> {
    let specs: Vec<Value> = serde_json::from_str(TOOL_SPECS).unwrap_or_default();
    specs
        .into_iter()
        .map(|t| json!({ "name": t["name"], "description": t["description"], "inputSchema": t["schema"] }))
        .collect()
}

/// A tool call, on to Magnolia; its answer, or why there isn't one.
fn forward(session: &str, client: &str, name: &str, input: &Value) -> Value {
    let not_running = json!({ "content": "Magnolia isn't open, or doesn't allow AI apps (Magnolia → Preferences → AI Assistance → Let AI apps on this computer use Magnolia). Ask the user to open Magnolia and their project, then try again.", "isError": true });
    let Some(endpoint) = data_dir().and_then(|d| std::fs::read_to_string(d.join(ENDPOINT_FILE)).ok()).and_then(|t| serde_json::from_str::<Value>(&t).ok()) else {
        return not_running;
    };
    let Some(port) = endpoint["port"].as_u64() else { return not_running };
    let Ok(mut sock) = std::net::TcpStream::connect_timeout(&([127, 0, 0, 1], port as u16).into(), Duration::from_secs(3)) else {
        return not_running;
    };
    let _ = sock.set_read_timeout(Some(CALL_TIMEOUT + Duration::from_secs(5)));
    let req = json!({ "token": endpoint["token"], "session": session, "client": client, "name": name, "input": input });
    if writeln!(sock, "{req}").is_err() {
        return not_running;
    }
    let mut line = String::new();
    if BufReader::new(sock).read_line(&mut line).is_err() || line.trim().is_empty() {
        return json!({ "content": "Magnolia didn't answer.", "isError": true });
    }
    serde_json::from_str(&line).unwrap_or_else(|_| json!({ "content": "Magnolia's answer couldn't be read.", "isError": true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn introduces_itself_and_lists_the_tools() {
        let mut client = String::new();
        let init = handle(&json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18", "clientInfo": { "name": "claude-ai" } } }), "s", &mut client).unwrap();
        assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
        assert!(init["result"]["capabilities"]["tools"].is_object());
        assert_eq!(client, "claude-ai");
        assert!(handle(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }), "s", &mut client).is_none());
        let list = handle(&json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }), "s", &mut client).unwrap();
        let tools = list["result"]["tools"].as_array().unwrap();
        assert!(tools.iter().any(|t| t["name"] == "propose_coding" && t["inputSchema"]["required"].is_array()));
        assert_eq!(tools.len(), 9);
        let unknown = handle(&json!({ "jsonrpc": "2.0", "id": 3, "method": "resources/list" }), "s", &mut client).unwrap();
        assert_eq!(unknown["error"]["code"], -32601);
    }

    #[test]
    fn a_call_reaches_magnolia_with_its_token() {
        let dir = std::env::temp_dir().join(format!("magnolia-mcp-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = server.local_addr().unwrap().port();
        std::fs::write(dir.join(ENDPOINT_FILE), json!({ "port": port, "token": "secret" }).to_string()).unwrap();
        let seen = std::thread::spawn(move || {
            let (sock, _) = server.accept().unwrap();
            let mut line = String::new();
            BufReader::new(sock.try_clone().unwrap()).read_line(&mut line).unwrap();
            let mut sock = sock;
            writeln!(sock, "{}", json!({ "content": "D1 | Interview | text | 120 characters", "isError": false })).unwrap();
            serde_json::from_str::<Value>(&line).unwrap()
        });
        // SAFETY: tests in this module don't read MAGNOLIA_MCP_DIR concurrently.
        unsafe { std::env::set_var("MAGNOLIA_MCP_DIR", &dir) };
        let mut client = String::from("claude-ai");
        let reply = handle(&json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": { "name": "list_documents", "arguments": {} } }), "sess", &mut client).unwrap();
        let req = seen.join().unwrap();
        assert_eq!(req["token"], "secret");
        assert_eq!(req["name"], "list_documents");
        assert_eq!(req["client"], "claude-ai");
        assert_eq!(reply["result"]["content"][0]["text"], "D1 | Interview | text | 120 characters");
        assert_eq!(reply["result"]["isError"], false);

        // Magnolia not listening: the AI app is told what to ask the user.
        std::fs::write(dir.join(ENDPOINT_FILE), json!({ "port": 1, "token": "x" }).to_string()).unwrap();
        let reply = handle(&json!({ "jsonrpc": "2.0", "id": 8, "method": "tools/call", "params": { "name": "list_codes" } }), "sess", &mut client).unwrap();
        assert_eq!(reply["result"]["isError"], true);
        assert!(reply["result"]["content"][0]["text"].as_str().unwrap().contains("Preferences"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn tokens_compare_whole() {
        assert!(same("abc", "abc"));
        assert!(!same("abc", "abd"));
        assert!(!same("abc", "abcd"));
    }
}
