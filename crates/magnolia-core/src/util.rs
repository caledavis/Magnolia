//! Small helpers shared across the crate.
//!
//! The project model travels between the renderer and Rust as JSON and is
//! handled here as `serde_json::Value`, mirroring the loosely-typed objects
//! the original TypeScript main process worked with. Unknown fields the
//! renderer adds therefore round-trip untouched. These helpers give that
//! dynamic model JavaScript-like semantics (truthiness, `parseInt`, number
//! formatting) where the on-disk format depends on them.

use serde_json::{Map, Value};

pub type Obj = Map<String, Value>;

/// Strip braces and upper-case a GUID. GUIDs are uppercase end-to-end in
/// Magnolia (renderer state, side tables, `sources/<guid>.<ext>` names and
/// the .qde attributes); a missing guid becomes `""`.
pub fn normalize_guid(guid: Option<&str>) -> String {
    match guid {
        Some(g) => g.replace(['{', '}'], "").to_uppercase(),
        None => String::new(),
    }
}

pub fn new_guid() -> String {
    uuid::Uuid::new_v4().to_string().to_uppercase()
}

/// Codepoint length — Magnolia indexes every text offset by codepoint.
pub fn cp_len(s: &str) -> usize {
    s.chars().count()
}

/// JavaScript truthiness.
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `obj?.[key]` treated with JS truthiness.
pub fn has(v: &Value, key: &str) -> bool {
    v.get(key).is_some_and(truthy)
}

pub fn get_str<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

/// A string field, but only when it is a non-empty string (`if (x.foo)`).
pub fn get_nonempty<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    get_str(v, key).filter(|s| !s.is_empty())
}

pub fn get_arr<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v.get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

pub fn get_f64(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(Value::as_f64)
}

/// Insert `key: value` only when the value is present (JS objects built with
/// `if (x) obj.key = x` / properties left `undefined`).
pub fn set_opt(obj: &mut Obj, key: &str, value: Option<impl Into<Value>>) {
    if let Some(v) = value {
        obj.insert(key.to_string(), v.into());
    }
}

/// JS `parseInt(s, 10)`: optional leading whitespace and sign, then the
/// longest run of digits. `None` stands in for `NaN`.
pub fn js_parse_int(s: Option<&str>) -> Option<i64> {
    let s = s?.trim_start();
    let (neg, rest) = match s.as_bytes().first() {
        Some(b'-') => (true, &s[1..]),
        Some(b'+') => (false, &s[1..]),
        _ => (false, s),
    };
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    let n: i64 = digits.parse().ok()?;
    Some(if neg { -n } else { n })
}

/// JS `parseFloat(s)`: the longest numeric prefix. `None` stands in for `NaN`.
pub fn js_parse_float(s: Option<&str>) -> Option<f64> {
    let s = s?.trim_start();
    let bytes = s.as_bytes();
    let mut end = 0;
    if end < bytes.len() && (bytes[end] == b'+' || bytes[end] == b'-') {
        end += 1;
    }
    if s[end..].starts_with("Infinity") {
        let v = f64::INFINITY;
        return Some(if bytes.first() == Some(&b'-') { -v } else { v });
    }
    let mut seen_digit = false;
    while end < bytes.len() && bytes[end].is_ascii_digit() {
        end += 1;
        seen_digit = true;
    }
    if end < bytes.len() && bytes[end] == b'.' {
        end += 1;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
            seen_digit = true;
        }
    }
    if !seen_digit {
        return None;
    }
    if end < bytes.len() && (bytes[end] == b'e' || bytes[end] == b'E') {
        let mut exp_end = end + 1;
        if exp_end < bytes.len() && (bytes[exp_end] == b'+' || bytes[exp_end] == b'-') {
            exp_end += 1;
        }
        let digits_start = exp_end;
        while exp_end < bytes.len() && bytes[exp_end].is_ascii_digit() {
            exp_end += 1;
        }
        if exp_end > digits_start {
            end = exp_end;
        }
    }
    s[..end].parse().ok()
}

/// A JSON number from an `f64`, collapsing integral values to integers so
/// they serialize the way JavaScript's `JSON.stringify` writes them.
pub fn num(f: f64) -> Value {
    if f.is_finite() && f.fract() == 0.0 && f.abs() < 9.007_199_254_740_992e15 {
        Value::from(f as i64)
    } else {
        serde_json::Number::from_f64(f)
            .map(Value::Number)
            .unwrap_or(Value::Null)
    }
}

/// JS `Math.round` (half rounds toward +∞, unlike Rust's `round`).
pub fn js_round(f: f64) -> f64 {
    (f + 0.5).floor()
}

/// JS `String(n)` for a number.
pub fn js_num_to_string(f: f64) -> String {
    if f.is_nan() {
        return "NaN".into();
    }
    if f.is_infinite() {
        return if f > 0.0 {
            "Infinity".into()
        } else {
            "-Infinity".into()
        };
    }
    if f.fract() == 0.0 && f.abs() < 1e21 {
        return format!("{}", f as i64);
    }
    // Rust's shortest round-trip formatting matches JS for the magnitudes
    // that occur in project data (coordinates, seconds, survey values).
    format!("{f}")
}

/// `String(value)` for a JSON value that the TS code called `.toString()` on.
pub fn js_to_string(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_num_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(js_to_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// The text after `internal://` in a REFI-QDA path attribute.
pub fn internal_name(path: Option<&str>) -> Option<&str> {
    let p = path?;
    let idx = p.find("internal://")?;
    let rest = &p[idx + "internal://".len()..];
    (!rest.is_empty()).then_some(rest)
}

/// Lower-cased extension after the last `.` (the whole string when there is
/// no dot, matching `split('.').pop()`).
pub fn ext_of(name: &str) -> String {
    name.rsplit('.').next().unwrap_or("").to_lowercase()
}

/// Flip the first hex nibble of a guid: deterministic, reversible and never
/// equal to the input. Used to derive distinct-but-stable child guids. The
/// TS versions differed in whether the flipped digit was upper-cased; the
/// `upper` flag preserves each call site's exact output.
pub fn flip_first_nibble(guid: &str, upper: bool) -> String {
    let Some(first) = guid.chars().next() else {
        return guid.to_string();
    };
    let Some(n) = first.to_digit(16) else {
        return guid.to_string();
    };
    let flipped = std::char::from_digit(15 - n, 16).unwrap();
    let flipped = if upper {
        flipped.to_ascii_uppercase()
    } else {
        flipped
    };
    format!("{flipped}{}", &guid[first.len_utf8()..])
}

/// ISO-8601 timestamp with millisecond precision, like `Date.toISOString()`.
pub fn now_iso() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

/// JS `String.prototype.trim` whitespace (includes the BOM, which Rust's
/// `trim` keeps).
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}
