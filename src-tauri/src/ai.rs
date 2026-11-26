//! AI Assistance: one turn of a conversation with the user's own AI
//! provider, streamed to the window.
//!
//! The renderer runs the conversation (it holds the project, so it answers
//! the model's requests for data and turns its proposals into changes for
//! the user to approve); this side only talks to the provider, so an API key
//! never reaches the page. Two kinds of API cover the providers people use:
//! Anthropic's Messages API, and the OpenAI-compatible Chat Completions API
//! (OpenAI itself, and Ollama, LM Studio, OpenRouter, Gemini and others).
//!
//! The conversation arrives in a neutral form, and each kind of API gets it
//! in its own:
//! - `{ "role": "user", "text": … }`
//! - `{ "role": "assistant", "text": …, "toolCalls": [{ "id", "name", "input" }] }`
//! - `{ "role": "tool", "results": [{ "id", "content", "isError" }] }`
//!
//! Keys are kept in the system's keychain, each under the address (scheme,
//! host and port) it was saved for, and sent only there: a key for
//! api.anthropic.com can't be sent anywhere else, whatever the page asks.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{Emitter, WebviewWindow};

/// The keychain's name for Magnolia's AI keys.
const KEYCHAIN_SERVICE: &str = "Magnolia AI Assistance";

/// The most a reply may run to, in tokens (Anthropic requires a limit).
const MAX_TOKENS: u32 = 8192;

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    /// "anthropic" or "openai" (any OpenAI-compatible service).
    pub kind: String,
    /// The API's address, e.g. https://api.anthropic.com or
    /// http://localhost:11434/v1.
    pub base_url: String,
    pub model: String,
}

#[derive(Deserialize)]
pub struct Tool {
    pub name: String,
    pub description: String,
    pub schema: Value,
}

/// What went wrong, for the window to explain in the user's language.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiError {
    /// noKey, auth, notFound, rateLimit, overloaded, unreachable, badAddress,
    /// keychain, provider, cancelled.
    pub code: String,
    /// The provider's own words, if any.
    pub detail: String,
}

impl AiError {
    fn new(code: &str, detail: impl Into<String>) -> Self {
        AiError { code: code.into(), detail: detail.into() }
    }
}

/// The address a key belongs to: scheme, host and port, lower case.
fn origin(base_url: &str) -> Result<String, AiError> {
    let url = reqwest::Url::parse(base_url.trim()).map_err(|_| AiError::new("badAddress", base_url))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(AiError::new("badAddress", base_url));
    }
    Ok(url.origin().ascii_serialization().to_lowercase())
}

/// Whether an address is this computer (a local model, which needs no key).
fn is_local(base_url: &str) -> bool {
    reqwest::Url::parse(base_url.trim())
        .ok()
        .and_then(|u| u.host_str().map(str::to_lowercase))
        .is_some_and(|h| h == "localhost" || h == "127.0.0.1" || h == "[::1]" || h == "::1")
}

fn entry(base_url: &str) -> Result<keyring::Entry, AiError> {
    keyring::Entry::new(KEYCHAIN_SERVICE, &origin(base_url)?).map_err(|e| AiError::new("keychain", e.to_string()))
}

fn key_for(base_url: &str) -> Result<Option<String>, AiError> {
    match entry(base_url)?.get_password() {
        Ok(k) => Ok(Some(k)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AiError::new("keychain", e.to_string())),
    }
}

#[tauri::command]
pub async fn ai_key_set(base_url: String, key: String) -> Result<(), AiError> {
    let key = key.trim();
    let e = entry(&base_url)?;
    if key.is_empty() {
        return match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(AiError::new("keychain", err.to_string())),
        };
    }
    e.set_password(key).map_err(|err| AiError::new("keychain", err.to_string()))
}

/// Whether a key is saved for this address (never the key itself).
#[tauri::command]
pub async fn ai_key_saved(base_url: String) -> Result<bool, AiError> {
    Ok(key_for(&base_url)?.is_some())
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            // Between pieces of a streamed reply (a local model can be slow
            // to start).
            .read_timeout(Duration::from_secs(300))
            .build()
            .expect("HTTP client")
    })
}

fn url(provider: &Provider, path: &str) -> String {
    let base = provider.base_url.trim().trim_end_matches('/');
    if provider.kind == "anthropic" {
        // Anthropic's address is given without /v1.
        let base = base.strip_suffix("/v1").unwrap_or(base);
        format!("{base}/v1/{path}")
    } else {
        format!("{base}/{path}")
    }
}

async fn request(provider: &Provider, method: reqwest::Method, path: &str) -> Result<reqwest::RequestBuilder, AiError> {
    let local = is_local(&provider.base_url);
    // A model on this computer needs no key, so a keychain that can't be
    // reached (a Linux desktop without a keyring service) doesn't stop it.
    let key = match key_for(&provider.base_url) {
        Err(_) if local => None,
        other => other?,
    };
    if key.is_none() && !local {
        return Err(AiError::new("noKey", ""));
    }
    let mut req = client().request(method, url(provider, path));
    if provider.kind == "anthropic" {
        req = req.header("anthropic-version", "2023-06-01");
        if let Some(k) = &key {
            req = req.header("x-api-key", k);
        }
    } else if let Some(k) = &key {
        req = req.bearer_auth(k);
    }
    Ok(req)
}

/// An unsuccessful reply, as an error with the provider's message.
async fn status_error(resp: reqwest::Response) -> AiError {
    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    let detail = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| {
            v.pointer("/error/message")
                .or_else(|| v.get("error").filter(|e| e.is_string()))
                .or_else(|| v.get("message"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| body.chars().take(300).collect());
    let code = match status {
        401 | 403 => "auth",
        404 => "notFound",
        429 => "rateLimit",
        500..=599 if status == 529 || status == 503 => "overloaded",
        _ => "provider",
    };
    AiError::new(code, format!("{status}: {detail}"))
}

fn send_error(e: reqwest::Error) -> AiError {
    AiError::new("unreachable", e.to_string())
}

/// The models a provider offers (for the model list in Preferences).
#[tauri::command]
pub async fn ai_models(provider: Provider) -> Result<Vec<String>, AiError> {
    let resp = request(&provider, reqwest::Method::GET, "models").await?.send().await.map_err(send_error)?;
    if !resp.status().is_success() {
        return Err(status_error(resp).await);
    }
    let v: Value = resp.json().await.map_err(send_error)?;
    let mut ids: Vec<String> = v["data"]
        .as_array()
        .or_else(|| v["models"].as_array())
        .map(|a| a.iter().filter_map(|m| m["id"].as_str().or_else(|| m["name"].as_str())).map(str::to_string).collect())
        .unwrap_or_default();
    if provider.kind != "anthropic" {
        ids.sort();
    }
    Ok(ids)
}

/// The conversation in Anthropic's form.
fn anthropic_body(system: &str, messages: &[Value], tools: &[Tool], model: &str) -> Value {
    let msgs: Vec<Value> = messages
        .iter()
        .filter_map(|m| match m["role"].as_str()? {
            "user" => Some(json!({ "role": "user", "content": m["text"].as_str().unwrap_or("") })),
            "assistant" => {
                let mut content = Vec::new();
                if let Some(t) = m["text"].as_str().filter(|t| !t.is_empty()) {
                    content.push(json!({ "type": "text", "text": t }));
                }
                for c in m["toolCalls"].as_array().into_iter().flatten() {
                    content.push(json!({ "type": "tool_use", "id": c["id"], "name": c["name"], "input": if c["input"].is_object() { c["input"].clone() } else { json!({}) } }));
                }
                (!content.is_empty()).then(|| json!({ "role": "assistant", "content": content }))
            }
            "tool" => {
                let content: Vec<Value> = m["results"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|r| json!({ "type": "tool_result", "tool_use_id": r["id"], "content": r["content"].as_str().unwrap_or(""), "is_error": r["isError"].as_bool().unwrap_or(false) }))
                    .collect();
                Some(json!({ "role": "user", "content": content }))
            }
            _ => None,
        })
        .collect();
    let mut body = json!({ "model": model, "max_tokens": MAX_TOKENS, "system": system, "messages": msgs, "stream": true });
    if !tools.is_empty() {
        body["tools"] = tools.iter().map(|t| json!({ "name": t.name, "description": t.description, "input_schema": t.schema })).collect();
    }
    body
}

/// The conversation in the OpenAI-compatible form.
fn openai_body(system: &str, messages: &[Value], tools: &[Tool], model: &str) -> Value {
    let mut msgs = vec![json!({ "role": "system", "content": system })];
    for m in messages {
        match m["role"].as_str() {
            Some("user") => msgs.push(json!({ "role": "user", "content": m["text"].as_str().unwrap_or("") })),
            Some("assistant") => {
                let calls: Vec<Value> = m["toolCalls"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|c| json!({ "id": c["id"], "type": "function", "function": { "name": c["name"], "arguments": c["input"].to_string() } }))
                    .collect();
                let mut msg = json!({ "role": "assistant", "content": m["text"].as_str().unwrap_or("") });
                if !calls.is_empty() {
                    msg["tool_calls"] = calls.into();
                }
                msgs.push(msg);
            }
            Some("tool") => {
                for r in m["results"].as_array().into_iter().flatten() {
                    msgs.push(json!({ "role": "tool", "tool_call_id": r["id"], "content": r["content"].as_str().unwrap_or("") }));
                }
            }
            _ => {}
        }
    }
    let mut body = json!({ "model": model, "messages": msgs, "stream": true });
    if !tools.is_empty() {
        body["tools"] = tools
            .iter()
            .map(|t| json!({ "type": "function", "function": { "name": t.name, "description": t.description, "parameters": t.schema } }))
            .collect();
    }
    body
}

/// A tool call being streamed in.
#[derive(Default)]
struct PartialCall {
    id: String,
    name: String,
    args: String,
}

/// The reply as it builds up from the stream's events.
#[derive(Default)]
struct Reply {
    text: String,
    calls: Vec<PartialCall>,
    /// Anthropic: which content block is which call.
    block_to_call: HashMap<u64, usize>,
    stop: String,
}

impl Reply {
    /// Feed one event's data; returns new text to show, if any.
    fn feed(&mut self, kind: &str, data: &Value) -> Result<Option<String>, AiError> {
        if kind == "anthropic" {
            match data["type"].as_str().unwrap_or("") {
                "content_block_start" if data["content_block"]["type"] == "tool_use" => {
                    let b = &data["content_block"];
                    self.calls.push(PartialCall { id: b["id"].as_str().unwrap_or("").into(), name: b["name"].as_str().unwrap_or("").into(), args: String::new() });
                    self.block_to_call.insert(data["index"].as_u64().unwrap_or(0), self.calls.len() - 1);
                }
                "content_block_delta" => {
                    let d = &data["delta"];
                    if let Some(t) = d["text"].as_str() {
                        self.text.push_str(t);
                        return Ok(Some(t.to_string()));
                    }
                    if let Some(j) = d["partial_json"].as_str()
                        && let Some(&i) = self.block_to_call.get(&data["index"].as_u64().unwrap_or(0))
                    {
                        self.calls[i].args.push_str(j);
                    }
                }
                "message_delta" => {
                    if let Some(s) = data["delta"]["stop_reason"].as_str() {
                        self.stop = s.into();
                    }
                }
                "error" => {
                    let msg = data["error"]["message"].as_str().unwrap_or("").to_string();
                    let code = if data["error"]["type"] == "overloaded_error" { "overloaded" } else { "provider" };
                    return Err(AiError::new(code, msg));
                }
                _ => {}
            }
            return Ok(None);
        }
        if let Some(e) = data.get("error") {
            return Err(AiError::new("provider", e["message"].as_str().map(str::to_string).unwrap_or_else(|| e.to_string())));
        }
        let choice = &data["choices"][0];
        if let Some(s) = choice["finish_reason"].as_str() {
            self.stop = s.into();
        }
        let d = &choice["delta"];
        for c in d["tool_calls"].as_array().into_iter().flatten() {
            let i = c["index"].as_u64().map(|i| i as usize).unwrap_or(self.calls.len().saturating_sub(1));
            while self.calls.len() <= i {
                self.calls.push(PartialCall::default());
            }
            let call = &mut self.calls[i];
            if let Some(id) = c["id"].as_str() {
                call.id = id.into();
            }
            if let Some(n) = c["function"]["name"].as_str() {
                call.name.push_str(n);
            }
            if let Some(a) = c["function"]["arguments"].as_str() {
                call.args.push_str(a);
            }
        }
        if let Some(t) = d["content"].as_str().filter(|t| !t.is_empty()) {
            self.text.push_str(t);
            return Ok(Some(t.to_string()));
        }
        Ok(None)
    }

    fn finish(self) -> Value {
        let calls: Vec<Value> = self
            .calls
            .into_iter()
            .enumerate()
            .filter(|(_, c)| !c.name.is_empty())
            .map(|(i, c)| {
                let input = if c.args.trim().is_empty() { Ok(json!({})) } else { serde_json::from_str::<Value>(&c.args) };
                let id = if c.id.is_empty() { format!("call_{i}") } else { c.id };
                match input {
                    Ok(v) => json!({ "id": id, "name": c.name, "input": v }),
                    // Cut off mid-call: the renderer tells the model.
                    Err(_) => json!({ "id": id, "name": c.name, "input": {}, "malformed": c.args }),
                }
            })
            .collect();
        json!({ "text": self.text, "toolCalls": calls, "stopReason": self.stop })
    }
}

/// The turns under way, to cancel.
fn running() -> &'static Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>> {
    static RUNNING: OnceLock<Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>> = OnceLock::new();
    RUNNING.get_or_init(Default::default)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase", tag = "type")]
enum Event {
    Text { request_id: String, text: String },
    Done { request_id: String, message: Value },
    Error { request_id: String, error: AiError },
}

/// One turn: `on_text` gets the reply's text as it comes; the result is the
/// whole message.
async fn turn(provider: &Provider, system: &str, messages: &[Value], tools: &[Tool], on_text: impl Fn(String)) -> Result<Value, AiError> {
    let anthropic = provider.kind == "anthropic";
    let (path, body) = if anthropic {
        ("messages", anthropic_body(system, messages, tools, &provider.model))
    } else {
        ("chat/completions", openai_body(system, messages, tools, &provider.model))
    };
    let resp = request(provider, reqwest::Method::POST, path).await?.json(&body).send().await.map_err(send_error)?;
    if !resp.status().is_success() {
        return Err(status_error(resp).await);
    }
    let kind = if anthropic { "anthropic" } else { "openai" };
    let mut reply = Reply::default();
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        buf.extend_from_slice(&chunk.map_err(send_error)?);
        // Server-sent events: blocks separated by a blank line.
        while let Some(end) = find_event_end(&buf) {
            let block: Vec<u8> = buf.drain(..end.0).collect();
            buf.drain(..end.1);
            let block = String::from_utf8_lossy(&block);
            let data: String = block
                .lines()
                .filter_map(|l| l.strip_prefix("data:"))
                .map(|l| l.strip_prefix(' ').unwrap_or(l))
                .collect::<Vec<_>>()
                .join("\n");
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(&data) else { continue };
            if let Some(text) = reply.feed(kind, &v)? {
                on_text(text);
            }
        }
    }
    Ok(reply.finish())
}

/// The end of the first event in `buf`: (where its text ends, how much
/// separator follows).
fn find_event_end(buf: &[u8]) -> Option<(usize, usize)> {
    for i in 0..buf.len() {
        if buf[i..].starts_with(b"\r\n\r\n") {
            return Some((i, 4));
        }
        if buf[i..].starts_with(b"\n\n") {
            return Some((i, 2));
        }
    }
    None
}

/// Start one turn: the model's reply streams to the window as `ai-event`s
/// (`text` as it comes, then `done` with the whole message, or `error`).
#[tauri::command]
pub async fn ai_chat(window: WebviewWindow, request_id: String, provider: Provider, system: String, messages: Vec<Value>, tools: Vec<Tool>) -> Result<(), AiError> {
    // Checked here, so a bad address or missing key fails the call itself.
    origin(&provider.base_url)?;
    let id = request_id.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let on_text = |text: String| {
            let _ = window.emit("ai-event", Event::Text { request_id: request_id.clone(), text });
        };
        let event = match turn(&provider, &system, &messages, &tools, on_text).await {
            Ok(message) => Event::Done { request_id: request_id.clone(), message },
            Err(error) => Event::Error { request_id: request_id.clone(), error },
        };
        let _ = window.emit("ai-event", event);
        running().lock().unwrap().remove(&request_id);
    });
    running().lock().unwrap().insert(id, handle);
    Ok(())
}

#[tauri::command]
pub async fn ai_cancel(window: WebviewWindow, request_id: String) {
    if let Some(h) = running().lock().unwrap().remove(&request_id) {
        h.abort();
        let _ = window.emit("ai-event", Event::Error { request_id, error: AiError::new("cancelled", "") });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_belongs_to_its_address() {
        assert_eq!(origin("https://api.anthropic.com").unwrap(), "https://api.anthropic.com");
        assert_eq!(origin("https://API.OpenAI.com/v1/").unwrap(), "https://api.openai.com");
        assert_eq!(origin("http://localhost:11434/v1").unwrap(), "http://localhost:11434");
        assert_eq!(origin("file:///etc/passwd").unwrap_err().code, "badAddress");
        assert_eq!(origin("not a url").unwrap_err().code, "badAddress");
        assert!(is_local("http://localhost:1234/v1"));
        assert!(is_local("http://127.0.0.1:11434"));
        assert!(!is_local("https://api.openai.com/v1"));
    }

    #[test]
    fn addresses() {
        let p = |kind: &str, base: &str| Provider { kind: kind.into(), base_url: base.into(), model: "m".into() };
        assert_eq!(url(&p("anthropic", "https://api.anthropic.com"), "messages"), "https://api.anthropic.com/v1/messages");
        assert_eq!(url(&p("anthropic", "https://api.anthropic.com/v1/"), "messages"), "https://api.anthropic.com/v1/messages");
        assert_eq!(url(&p("openai", "http://localhost:11434/v1"), "chat/completions"), "http://localhost:11434/v1/chat/completions");
    }

    fn conversation() -> Vec<Value> {
        vec![
            json!({ "role": "user", "text": "Suggest codes" }),
            json!({ "role": "assistant", "text": "Looking.", "toolCalls": [{ "id": "c1", "name": "search", "input": { "q": "cost" } }] }),
            json!({ "role": "tool", "results": [{ "id": "c1", "content": "3 passages", "isError": false }] }),
        ]
    }

    #[test]
    fn anthropic_form() {
        let tools = vec![Tool { name: "search".into(), description: "Search".into(), schema: json!({ "type": "object" }) }];
        let b = anthropic_body("sys", &conversation(), &tools, "claude-x");
        assert_eq!(b["system"], "sys");
        assert_eq!(b["messages"][1]["content"][1], json!({ "type": "tool_use", "id": "c1", "name": "search", "input": { "q": "cost" } }));
        assert_eq!(b["messages"][2]["role"], "user");
        assert_eq!(b["messages"][2]["content"][0]["tool_use_id"], "c1");
        assert_eq!(b["tools"][0]["input_schema"]["type"], "object");
    }

    #[test]
    fn openai_form() {
        let b = openai_body("sys", &conversation(), &[], "gpt-x");
        assert_eq!(b["messages"][0], json!({ "role": "system", "content": "sys" }));
        assert_eq!(b["messages"][2]["tool_calls"][0]["function"]["arguments"], r#"{"q":"cost"}"#);
        assert_eq!(b["messages"][3], json!({ "role": "tool", "tool_call_id": "c1", "content": "3 passages" }));
        assert!(b.get("tools").is_none());
    }

    #[test]
    fn reads_an_anthropic_stream() {
        let mut r = Reply::default();
        let events = [
            json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": "Hel" } }),
            json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": "lo" } }),
            json!({ "type": "content_block_start", "index": 1, "content_block": { "type": "tool_use", "id": "t1", "name": "search" } }),
            json!({ "type": "content_block_delta", "index": 1, "delta": { "type": "input_json_delta", "partial_json": "{\"q\":" } }),
            json!({ "type": "content_block_delta", "index": 1, "delta": { "type": "input_json_delta", "partial_json": "\"x\"}" } }),
            json!({ "type": "message_delta", "delta": { "stop_reason": "tool_use" } }),
        ];
        for e in &events {
            r.feed("anthropic", e).unwrap();
        }
        let m = r.finish();
        assert_eq!(m["text"], "Hello");
        assert_eq!(m["toolCalls"][0], json!({ "id": "t1", "name": "search", "input": { "q": "x" } }));
        assert_eq!(m["stopReason"], "tool_use");
    }

    #[test]
    fn reads_an_openai_stream() {
        let mut r = Reply::default();
        let events = [
            json!({ "choices": [{ "delta": { "content": "Hi" } }] }),
            json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "id": "a", "function": { "name": "search", "arguments": "{\"q\"" } }] } }] }),
            json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "function": { "arguments": ":1}" } }] } }] }),
            json!({ "choices": [{ "delta": {}, "finish_reason": "tool_calls" }] }),
        ];
        for e in &events {
            r.feed("openai", e).unwrap();
        }
        let m = r.finish();
        assert_eq!(m["text"], "Hi");
        assert_eq!(m["toolCalls"][0], json!({ "id": "a", "name": "search", "input": { "q": 1 } }));
        assert_eq!(m["stopReason"], "tool_calls");
    }

    #[test]
    fn a_cut_off_call_is_marked() {
        let mut r = Reply::default();
        r.feed("openai", &json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "id": "a", "function": { "name": "search", "arguments": "{\"q\":" } }] } }] })).unwrap();
        assert_eq!(r.finish()["toolCalls"][0]["malformed"], "{\"q\":");
    }

    #[test]
    fn an_error_in_the_stream_stops_it() {
        let mut r = Reply::default();
        let e = r.feed("anthropic", &json!({ "type": "error", "error": { "type": "overloaded_error", "message": "Overloaded" } })).unwrap_err();
        assert_eq!(e, AiError::new("overloaded", "Overloaded"));
    }

    /// A one-request server on this computer that replies with `body` as
    /// server-sent events; returns its address and what it was sent.
    fn fake_service(body: &'static str) -> (String, std::sync::mpsc::Receiver<String>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = format!("http://{}", listener.local_addr().unwrap());
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut buf = vec![0u8; 65536];
            let mut got = Vec::new();
            // Headers, then the body (by its length).
            loop {
                let n = sock.read(&mut buf).unwrap();
                got.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&got).to_string();
                if let Some(h) = text.find("\r\n\r\n") {
                    let len = text[..h].lines().find_map(|l| l.to_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap())).unwrap_or(0);
                    if got.len() >= h + 4 + len {
                        tx.send(text).unwrap();
                        break;
                    }
                }
            }
            let reply = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
            sock.write_all(reply.as_bytes()).unwrap();
        });
        (addr, rx)
    }

    #[test]
    fn a_turn_with_a_local_openai_compatible_service() {
        let body = "data: {\"choices\":[{\"delta\":{\"content\":\"Two \"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"passages.\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"function\":{\"name\":\"search_text\",\"arguments\":\"{\\\"text\\\":\\\"cost\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n";
        let (addr, sent) = fake_service(body);
        let provider = Provider { kind: "openai".into(), base_url: format!("{addr}/v1"), model: "local-model".into() };
        let pieces = std::sync::Mutex::new(Vec::new());
        let msg = tauri::async_runtime::block_on(turn(&provider, "sys", &[json!({ "role": "user", "text": "hi" })], &[], |t| pieces.lock().unwrap().push(t))).unwrap();
        assert_eq!(msg["text"], "Two passages.");
        assert_eq!(msg["toolCalls"][0], json!({ "id": "c1", "name": "search_text", "input": { "text": "cost" } }));
        assert_eq!(*pieces.lock().unwrap(), vec!["Two ".to_string(), "passages.".to_string()]);
        let request = sent.recv().unwrap();
        assert!(request.starts_with("POST /v1/chat/completions"), "{request}");
        assert!(request.contains(r#""model":"local-model""#));
        assert!(!request.to_lowercase().contains("authorization"), "no key for a local service");
    }

    #[test]
    fn a_turn_with_anthropics_api() {
        let body = "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello\"}}\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n\n";
        let (addr, sent) = fake_service(body);
        let provider = Provider { kind: "anthropic".into(), base_url: addr, model: "claude-x".into() };
        let msg = tauri::async_runtime::block_on(turn(&provider, "sys", &[json!({ "role": "user", "text": "hi" })], &[], |_| {})).unwrap();
        assert_eq!(msg["text"], "Hello");
        assert_eq!(msg["stopReason"], "end_turn");
        let request = sent.recv().unwrap();
        assert!(request.starts_with("POST /v1/messages"), "{request}");
        assert!(request.contains("anthropic-version: 2023-06-01"));
    }

    #[test]
    fn a_key_is_needed_away_from_this_computer() {
        let provider = Provider { kind: "openai".into(), base_url: "https://no-key-saved.invalid/v1".into(), model: "m".into() };
        let err = tauri::async_runtime::block_on(turn(&provider, "", &[], &[], |_| {})).unwrap_err();
        assert!(err.code == "noKey" || err.code == "keychain", "{err:?}");
    }

    #[test]
    fn splits_events() {
        assert_eq!(find_event_end(b"data: x\n\ndata: y"), Some((7, 2)));
        assert_eq!(find_event_end(b"data: x\r\n\r\n"), Some((7, 4)));
        assert_eq!(find_event_end(b"data: x\n"), None);
    }
}
