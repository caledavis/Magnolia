//! Audio/video transcript ⇄ REFI-QDA `<Transcript>`/`<SyncPoint>` interop.
//!
//! Magnolia keeps a media transcript as plain text plus a `lineTimes` map
//! (line index → seconds) in the `magnolia-sources.json` side table. The
//! QDA-XML schema expresses the same thing as a `<Transcript>` whose
//! `<SyncPoint>`s pin character offsets to media times; `build_transcript`
//! produces that on save and `reconstruct_line_times` reverses it on load so a
//! transcript that passed through another tool comes back time-synced.

use crate::util::{Obj, cp_len, get_arr, get_f64, get_str, js_round, num, truthy};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};

/// Derive the Transcript's own guid from the source guid (first nibble
/// flipped, lower-case digit as in the TS original).
fn transcript_guid_for(source_guid: &str) -> String {
    crate::util::flip_first_nibble(source_guid, false)
}

/// Guid of the transcript twin of a video selection (first nibble flipped).
pub fn transcript_twin_guid_for(guid: &str) -> String {
    crate::util::flip_first_nibble(guid, true)
}

/// Stable SyncPoint guid: the source's first 24 chars plus the zero-padded
/// hex position. Keying on position lets a line-start point and a coding
/// boundary at the same offset share one guid.
fn sync_point_guid_for(source_guid: &str, position: i64) -> String {
    let prefix: String = source_guid.chars().take(24).collect();
    let hex = format!("{:012X}", position);
    format!("{prefix}{}", &hex[hex.len() - 12..])
}

/// Interpolate a media time (ms) for an arbitrary character position from the
/// known line-start (position, time) anchors. Atlas rejects a SyncPoint
/// without a timeStamp, so every coding boundary needs one.
fn interpolate_time(position: f64, timed: &[(f64, f64)]) -> f64 {
    if timed.is_empty() {
        return position;
    }
    let mut lo: Option<(f64, f64)> = None;
    let mut hi: Option<(f64, f64)> = None;
    for &p in timed {
        if p.0 <= position {
            lo = Some(p);
        }
        if p.0 >= position && hi.is_none() {
            hi = Some(p);
        }
    }
    match (lo, hi) {
        (Some(lo), Some(hi)) => {
            if hi.0 == lo.0 {
                lo.1
            } else {
                js_round(lo.1 + ((position - lo.0) / (hi.0 - lo.0)) * (hi.1 - lo.1))
            }
        }
        (Some(lo), None) if timed.len() >= 2 => {
            let a = timed[timed.len() - 2];
            let b = timed[timed.len() - 1];
            let rate = (b.1 - a.1) / (b.0 - a.0).max(1.0);
            js_round(lo.1 + (position - lo.0) * rate)
        }
        (Some(lo), None) => lo.1,
        (None, Some(hi)) => hi.1,
        (None, None) => position,
    }
}

/// Codepoint offset of the start of each line.
fn line_start_offsets(text: &str) -> Vec<usize> {
    let mut starts = Vec::new();
    let mut cp = 0;
    for line in text.split('\n') {
        starts.push(cp);
        cp += cp_len(line) + 1;
    }
    starts
}

/// Line starts plus a trailing total: line i spans `[o[i], o[i+1])`.
pub fn line_start_offsets_with_end(text: &str) -> Vec<usize> {
    let mut out = line_start_offsets(text);
    let total = text.split('\n').map(|l| cp_len(l) + 1).sum();
    out.push(total);
    out
}

pub fn line_for_char(text: &str, cp: f64) -> usize {
    let offsets = line_start_offsets_with_end(text);
    // The last line whose start is at or before `cp` (the trailing total
    // isn't a line start).
    offsets[..offsets.len() - 1]
        .iter()
        .take_while(|&&o| cp >= o as f64)
        .count()
        .saturating_sub(1)
}

/// True for a character-offset transcript coding — has codings and a
/// non-empty span, and isn't a PDF/image region or survey cell.
pub fn is_transcript_coding(sel: &Value) -> bool {
    let has_codings = sel
        .get("codings")
        .and_then(Value::as_array)
        .is_some_and(|a| !a.is_empty());
    let (Some(s), Some(e)) = (get_f64(sel, "startPosition"), get_f64(sel, "endPosition")) else {
        return false;
    };
    has_codings
        && e > s
        && !crate::util::has(sel, "pdfRegion")
        && !crate::util::has(sel, "surveyCell")
}

/// Build a `<Transcript>` for an audio/video source from its text, lineTimes
/// and char-offset codings. Returns `None` when there's nothing to emit.
pub fn build_transcript(
    source_guid: &str,
    text: &str,
    line_times: Option<&Value>,
    selections: &[Value],
) -> Option<Value> {
    let has_text = !text.trim().is_empty();
    let line_times = line_times
        .and_then(Value::as_object)
        .filter(|m| !m.is_empty());
    let codings: Vec<&Value> = selections
        .iter()
        .filter(|s| is_transcript_coding(s))
        .collect();
    if !has_text && line_times.is_none() && codings.is_empty() {
        return None;
    }

    let starts = line_start_offsets(text);
    // position → (guid, timeStamp)
    let mut by_pos: BTreeMap<i64, (String, Option<i64>)> = BTreeMap::new();
    let sync_at =
        |by_pos: &mut BTreeMap<i64, (String, Option<i64>)>, pos: i64, ts: Option<i64>| -> String {
            let entry = by_pos
                .entry(pos)
                .or_insert_with(|| (sync_point_guid_for(source_guid, pos), None));
            if ts.is_some() && entry.1.is_none() {
                entry.1 = ts;
            }
            entry.0.clone()
        };

    if let Some(lt) = line_times {
        for (idx, secs) in lt {
            let Some(i) = crate::util::js_parse_int(Some(idx)) else {
                continue;
            };
            if i < 0 {
                continue;
            }
            let Some(secs) = secs.as_f64().filter(|f| f.is_finite()) else {
                continue;
            };
            let pos = starts.get(i as usize).copied().unwrap_or(0) as i64;
            sync_at(&mut by_pos, pos, Some(js_round(secs * 1000.0) as i64));
        }
    }

    let timed_anchors: Vec<(f64, f64)> = by_pos
        .iter()
        .filter_map(|(p, (_, ts))| ts.map(|t| (*p as f64, t as f64)))
        .collect();

    let transcript_selections: Vec<Value> = codings
        .iter()
        .map(|sel| {
            let sp = get_f64(sel, "startPosition").unwrap();
            let ep = get_f64(sel, "endPosition").unwrap();
            let from = sync_at(
                &mut by_pos,
                sp as i64,
                Some(interpolate_time(sp, &timed_anchors) as i64),
            );
            let to = sync_at(
                &mut by_pos,
                ep as i64,
                Some(interpolate_time(ep, &timed_anchors) as i64),
            );
            let mut o = Obj::new();
            o.insert(
                "guid".into(),
                sel.get("guid").cloned().unwrap_or(Value::Null),
            );
            copy_opt(&mut o, sel, "name");
            o.insert("fromSyncPoint".into(), from.into());
            o.insert("toSyncPoint".into(), to.into());
            copy_opt(&mut o, sel, "creatingUser");
            copy_opt(&mut o, sel, "creationDateTime");
            o.insert(
                "codings".into(),
                sel.get("codings").cloned().unwrap_or(json!([])),
            );
            Value::Object(o)
        })
        .collect();

    let sync_points: Vec<Value> = by_pos
        .into_iter()
        .map(|(pos, (guid, ts))| {
            let mut o = Obj::new();
            o.insert("guid".into(), guid.into());
            o.insert("position".into(), pos.into());
            if let Some(t) = ts {
                o.insert("timeStamp".into(), t.into());
            }
            Value::Object(o)
        })
        .collect();

    Some(json!({
        "guid": transcript_guid_for(source_guid),
        "plainTextPath": format!("internal://{source_guid}.txt"),
        "syncPoints": sync_points,
        "selections": transcript_selections,
    }))
}

fn copy_opt(o: &mut Obj, from: &Value, key: &str) {
    if let Some(v) = from.get(key).filter(|v| !v.is_null()) {
        o.insert(key.into(), v.clone());
    }
}

/// Derive a video time range (seconds) for a coded character span from the
/// transcript's per-line times: the start line's time to the following
/// line's time.
pub fn derive_line_time_range(
    text: &str,
    start_cp: f64,
    end_cp: f64,
    line_times: Option<&Value>,
) -> Option<Value> {
    let lt = line_times?.as_object().filter(|m| !m.is_empty())?;
    let start_line = line_for_char(text, start_cp);
    let end_line = line_for_char(text, (end_cp - 1.0).max(start_cp));
    let at = |line: usize| lt.get(&line.to_string()).and_then(Value::as_f64);
    let start_time = at(start_line)?;
    let end_time = at(end_line + 1)
        .or_else(|| at(end_line))
        .unwrap_or(start_time);
    Some(json!({ "startTime": num(start_time), "endTime": num(end_time.max(start_time)) }))
}

/// Turn a parsed transcript's `<TranscriptSelection>`s back into char-offset
/// codings by resolving each from/to SyncPoint to its position.
pub fn reconstruct_transcript_selections(transcript: &Value) -> Vec<Value> {
    let mut pos_by_guid: HashMap<&str, f64> = HashMap::new();
    for sp in get_arr(transcript, "syncPoints") {
        if let (Some(g), Some(p)) = (get_str(sp, "guid"), get_f64(sp, "position")) {
            pos_by_guid.insert(g, p);
        }
    }
    let mut out = Vec::new();
    for ts in get_arr(transcript, "selections") {
        let a = get_str(ts, "fromSyncPoint").and_then(|g| pos_by_guid.get(g));
        let b = get_str(ts, "toSyncPoint").and_then(|g| pos_by_guid.get(g));
        let (Some(&a), Some(&b)) = (a, b) else {
            continue;
        };
        let mut o = Obj::new();
        o.insert(
            "guid".into(),
            ts.get("guid").cloned().unwrap_or(Value::Null),
        );
        copy_opt(&mut o, ts, "name");
        o.insert("startPosition".into(), num(a.min(b)));
        o.insert("endPosition".into(), num(a.max(b)));
        copy_opt(&mut o, ts, "creatingUser");
        copy_opt(&mut o, ts, "creationDateTime");
        o.insert(
            "codings".into(),
            ts.get("codings").cloned().unwrap_or(json!([])),
        );
        out.push(Value::Object(o));
    }
    out
}

/// Turn SyncPoints back into a `lineTimes` map against the transcript text.
/// Only points sitting exactly on a line start count — coding boundaries
/// carry timestamps too and must not overwrite real line times.
pub fn reconstruct_line_times(text: &str, sync_points: &[Value]) -> Map<String, Value> {
    let mut out = Map::new();
    if text.is_empty() || sync_points.is_empty() {
        return out;
    }
    let starts = line_start_offsets(text);
    let line_by_start: HashMap<usize, usize> =
        starts.iter().enumerate().map(|(i, p)| (*p, i)).collect();
    for sp in sync_points {
        let (Some(ts), Some(pos)) = (get_f64(sp, "timeStamp"), get_f64(sp, "position")) else {
            continue;
        };
        if pos < 0.0 || pos.fract() != 0.0 {
            continue;
        }
        if let Some(line) = line_by_start.get(&(pos as usize)) {
            out.insert(line.to_string(), num(ts / 1000.0));
        }
    }
    out
}

/// Per-source path lookups captured by the reader before paths are cleared.
#[derive(Default)]
pub struct MediaTranscriptPaths {
    pub media_path_by_guid: HashMap<String, String>,
    pub transcript_file_by_guid: HashMap<String, String>,
    pub text_file_by_guid: HashMap<String, String>,
}

/// Collapse the up-to-three sources another tool (Atlas) emits for ONE coded
/// video/audio — the media source, a standalone transcript `<TextSource>`
/// with the codings, and a second media source re-referencing the transcript
/// — into a single media document with an inline transcript.
pub fn reconcile_media_transcripts(
    sources: Vec<Value>,
    source_contents: &mut Map<String, Value>,
    paths: &MediaTranscriptPaths,
) -> Vec<Value> {
    let transcript_text_files: HashSet<&String> = paths.transcript_file_by_guid.values().collect();
    if transcript_text_files.is_empty() {
        return sources;
    }
    let mut sources = sources;
    let guid_of = |s: &Value| get_str(s, "guid").unwrap_or("").to_string();
    let type_of = |s: &Value| get_str(s, "sourceType").map(str::to_string);

    // 1. Standalone transcript text sources: gather text + codings, mark removed.
    let mut removed: HashSet<String> = HashSet::new();
    let mut codings_by_file: HashMap<String, Vec<Value>> = HashMap::new();
    let mut text_by_file: HashMap<String, String> = HashMap::new();
    for s in &sources {
        if let Some(t) = type_of(s)
            && !t.is_empty()
            && t != "text"
        {
            continue;
        }
        let g = guid_of(s);
        let Some(file) = paths.text_file_by_guid.get(&g) else {
            continue;
        };
        if !transcript_text_files.contains(file) {
            continue;
        }
        codings_by_file
            .entry(file.clone())
            .or_default()
            .extend(get_arr(s, "selections").iter().cloned());
        if let Some(text) = source_contents
            .get(&g)
            .filter(|v| truthy(v))
            .and_then(Value::as_str)
        {
            text_by_file.insert(file.clone(), text.to_string());
        }
        removed.insert(g);
    }

    // 2. Group media sources by media path (insertion order preserved).
    let mut group_order: Vec<String> = Vec::new();
    let mut by_media: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, s) in sources.iter().enumerate() {
        let t = type_of(s);
        if t.as_deref() != Some("audio") && t.as_deref() != Some("video") {
            continue;
        }
        let g = guid_of(s);
        if removed.contains(&g) {
            continue;
        }
        let Some(p) = paths.media_path_by_guid.get(&g) else {
            continue;
        };
        if !by_media.contains_key(p) {
            group_order.push(p.clone());
        }
        by_media.entry(p.clone()).or_default().push(i);
    }
    let transcript_re = regex::Regex::new("(?i)transcript").unwrap();
    for p in group_order {
        let group = &by_media[&p];
        let Some(file) = group
            .iter()
            .find_map(|&i| paths.transcript_file_by_guid.get(&guid_of(&sources[i])))
            .cloned()
        else {
            continue;
        };
        let canonical = *group
            .iter()
            .find(|&&i| !transcript_re.is_match(get_str(&sources[i], "name").unwrap_or("")))
            .unwrap_or(&group[0]);
        let canonical_guid = guid_of(&sources[canonical]);
        let text = text_by_file.get(&file);
        if let Some(t) = text {
            source_contents.insert(canonical_guid.clone(), t.clone().into());
        }
        let line_times = sources[canonical]
            .get("formatData")
            .and_then(|f| f.get("lineTimes"))
            .cloned();
        let folded: Vec<Value> = codings_by_file
            .get(&file)
            .map(|v| v.as_slice())
            .unwrap_or(&[])
            .iter()
            .map(|sel| {
                let tr = text.and_then(|t| {
                    derive_line_time_range(
                        t,
                        get_f64(sel, "startPosition").unwrap_or(0.0),
                        get_f64(sel, "endPosition").unwrap_or(0.0),
                        line_times.as_ref(),
                    )
                });
                match tr {
                    Some(tr) => {
                        let mut s = sel.clone();
                        s["timeRange"] = tr;
                        s
                    }
                    None => sel.clone(),
                }
            })
            .collect();
        if !folded.is_empty() {
            let c = &mut sources[canonical];
            let mut sels = get_arr(c, "selections").to_vec();
            sels.extend(folded);
            c["selections"] = sels.into();
        }
        for &i in group {
            if i != canonical {
                removed.insert(guid_of(&sources[i]));
            }
        }
    }

    if removed.is_empty() {
        return sources;
    }
    for g in &removed {
        source_contents.remove(g);
    }
    sources.retain(|s| !removed.contains(&guid_of(s)));
    sources
}
