//! Transcripts, Atlas-style media reconciliation and relationship maps
//! (ported from transcript-refi, media-transcript-reconcile and graph-refi
//! tests).

mod common;
use common::*;
use magnolia_core::qdpx::deserializer::deserialize_project;
use magnolia_core::qdpx::graph_refi::{GraphEntity, collect_graphs, graph_to_map, map_to_graph};
use magnolia_core::qdpx::serializer::serialize_project;
use magnolia_core::qdpx::transcript_refi::*;
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};

const AUDIO: &str = "D1111111-1111-1111-1111-111111111111";
const VIDEO: &str = "E2222222-2222-2222-2222-222222222222";
const CODE: &str = "C0DEC0DE-0000-4000-8000-00000000C0DE";
const TEXT: &str = "Hello world\nSecond line\nThird";

fn line_times() -> Value {
    json!({ "0": 0, "1": 2.5, "2": 5 })
}

fn audio_selections() -> Vec<Value> {
    vec![
        json!({ "guid": "D1111111-1111-1111-1111-00000000C001", "startPosition": 12, "endPosition": 23,
                 "codings": [{ "guid": "D1111111-1111-1111-1111-00000000A001", "codeGuid": CODE }] }),
    ]
}

fn project(sources: Vec<Value>, with_code: bool) -> Value {
    let codes = if with_code {
        json!([{ "guid": CODE, "name": "theme", "isCodable": true, "children": [] }])
    } else {
        json!([])
    };
    json!({ "name": "Media Project", "origin": "Magnolia test",
            "users": [{ "guid": "00000000-0000-0000-0000-000000000001", "name": "T" }],
            "codes": codes, "sources": sources, "sets": [], "notes": [] })
}

fn with_transcript(mut source: Value, sels: &[Value]) -> Value {
    let guid = source["guid"].as_str().unwrap().to_string();
    source["_refiTranscript"] = build_transcript(&guid, TEXT, Some(&line_times()), sels).unwrap();
    source
}

fn project_with_transcripts() -> Value {
    let audio = with_transcript(
        json!({ "guid": AUDIO, "name": "Recording", "sourceType": "audio",
                "formatData": { "audioExt": "m4a", "lineTimes": line_times() }, "selections": audio_selections() }),
        &audio_selections(),
    );
    let video = with_transcript(
        json!({ "guid": VIDEO, "name": "Clip", "sourceType": "video", "formatData": { "videoExt": "mp4", "lineTimes": line_times() },
                "selections": [{ "guid": "E2222222-2222-2222-2222-0000000000C1", "startPosition": 0, "endPosition": 0,
                                 "timeRange": { "startTime": 1, "endTime": 2 }, "codings": [] }] }),
        &[],
    );
    project(vec![audio, video], true)
}

fn sorted_points(t: &Value) -> Vec<Value> {
    let mut v = t["syncPoints"].as_array().unwrap().clone();
    v.sort_by_key(|s| s["position"].as_i64().unwrap());
    v
}

#[test]
fn build_transcript_turns_line_times_into_sync_points() {
    let t = build_transcript(AUDIO, TEXT, Some(&line_times()), &[]).unwrap();
    assert_ne!(t["guid"], AUDIO);
    let pts = sorted_points(&t);
    assert_eq!(
        pts.iter()
            .map(|p| p["position"].as_i64().unwrap())
            .collect::<Vec<_>>(),
        vec![0, 12, 24]
    );
    assert_eq!(
        pts.iter()
            .map(|p| p["timeStamp"].as_i64().unwrap())
            .collect::<Vec<_>>(),
        vec![0, 2500, 5000]
    );
    assert_eq!(
        pts.iter()
            .map(|p| p["guid"].as_str().unwrap())
            .collect::<HashSet<_>>()
            .len(),
        3
    );
}

#[test]
fn build_transcript_is_none_for_silent_untimed_source() {
    assert!(build_transcript(AUDIO, "", None, &[]).is_none());
}

#[test]
fn reconstruct_line_times_inverts_build_transcript() {
    let t = build_transcript(AUDIO, TEXT, Some(&line_times()), &[]).unwrap();
    assert_eq!(
        Value::Object(reconstruct_line_times(
            TEXT,
            t["syncPoints"].as_array().unwrap()
        )),
        line_times()
    );
}

#[test]
fn transcripts_validate_against_xsd() {
    validate(&serialize_project(&project_with_transcripts(), APP_VERSION)).unwrap();
}

#[test]
fn transcript_precedes_video_selection() {
    let xml = serialize_project(&project_with_transcripts(), APP_VERSION);
    assert!(xml.contains("<SyncPoint"));
    assert!(xml.find("<Transcript").unwrap() < xml.find("<VideoSelection").unwrap());
}

#[test]
fn coded_audio_transcript_splits_into_atlas_layout() {
    let parsed =
        deserialize_project(&serialize_project(&project_with_transcripts(), APP_VERSION)).unwrap();
    let sources = parsed["sources"].as_array().unwrap();
    let media = sources.iter().find(|s| s["guid"] == AUDIO).unwrap();
    assert!(media.get("_refiTranscript").is_none());
    let text_src = sources
        .iter()
        .find(|s| {
            s["guid"] != AUDIO
                && !s["selections"].as_array().unwrap().is_empty()
                && s["plainTextPath"]
                    .as_str()
                    .unwrap_or("")
                    .contains(&format!("{AUDIO}.txt"))
        })
        .unwrap();
    assert_eq!(text_src["selections"][0]["startPosition"], 12);
    assert_eq!(text_src["selections"][0]["endPosition"], 23);
    assert_eq!(text_src["selections"][0]["codings"][0]["codeGuid"], CODE);
    let tsrc = sources
        .iter()
        .find(|s| {
            s.get("_refiTranscript").is_some_and(|t| {
                t["plainTextPath"]
                    .as_str()
                    .unwrap()
                    .contains(&format!("{AUDIO}.txt"))
            })
        })
        .unwrap();
    let lt = reconstruct_line_times(
        TEXT,
        tsrc["_refiTranscript"]["syncPoints"].as_array().unwrap(),
    );
    assert_eq!(Value::Object(lt), line_times());
}

#[test]
fn transcript_coding_rides_on_plain_text_selection_not_transcript_selection() {
    let xml = serialize_project(&project_with_transcripts(), APP_VERSION);
    assert!(!xml.contains("<TranscriptSelection"));
    assert!(
        regex::Regex::new(&format!(
            r#"<PlainTextSelection[\s\S]*?<CodeRef targetGUID="{CODE}""#
        ))
        .unwrap()
        .is_match(&xml)
    );
}

#[test]
fn every_sync_point_is_timed_and_monotonic() {
    let t = build_transcript(AUDIO, TEXT, Some(&line_times()), &audio_selections()).unwrap();
    let pts = sorted_points(&t);
    assert_eq!(pts.len(), 4);
    let times: Vec<i64> = pts
        .iter()
        .map(|p| p["timeStamp"].as_i64().expect("timed"))
        .collect();
    assert!(times.windows(2).all(|w| w[1] >= w[0]));
    let boundary = pts.iter().find(|p| p["position"] == 23).unwrap()["timeStamp"]
        .as_i64()
        .unwrap();
    assert!(boundary > 2500 && boundary < 5000);
    assert_eq!(
        Value::Object(reconstruct_line_times(TEXT, &pts)),
        line_times()
    );
}

fn video_coding() -> Value {
    json!({ "guid": "B0000000-0000-4000-8000-000000000001", "startPosition": 12, "endPosition": 23,
            "timeRange": { "startTime": 2.5, "endTime": 5 },
            "codings": [{ "guid": "A0000000-0000-4000-8000-00000000000C", "codeGuid": CODE }] })
}

#[test]
fn video_coding_becomes_one_transcript_selection_keeping_its_guid() {
    let t = build_transcript(VIDEO, TEXT, Some(&line_times()), &[video_coding()]).unwrap();
    let sels = t["selections"].as_array().unwrap();
    assert_eq!(sels.len(), 1);
    assert_eq!(sels[0]["guid"], "B0000000-0000-4000-8000-000000000001");
    assert_eq!(sels[0]["codings"][0]["codeGuid"], CODE);
    let a = build_transcript(AUDIO, TEXT, Some(&line_times()), &audio_selections()).unwrap();
    assert!(
        a["selections"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["guid"] == audio_selections()[0]["guid"])
    );
}

#[test]
fn coded_video_transcript_serializes_as_three_source_split() {
    let sels = vec![video_coding()];
    let video = with_transcript(
        json!({ "guid": VIDEO, "name": "Clip", "sourceType": "video", "formatData": { "videoExt": "mp4", "lineTimes": line_times() }, "selections": sels }),
        &sels,
    );
    let xml = serialize_project(&project(vec![video], true), APP_VERSION);
    assert!(!xml.contains("<TranscriptSelection"));
    assert!(!xml.contains("<VideoSelection"));
    let refs: Vec<String> = regex::Regex::new(r#"plainTextPath="internal://([^"]+)""#)
        .unwrap()
        .captures_iter(&xml)
        .map(|c| c[1].to_string())
        .collect();
    assert_eq!(
        refs.iter()
            .filter(|r| **r == format!("{VIDEO}.txt"))
            .count(),
        2
    );
    let guids: Vec<String> = regex::Regex::new(r#"\bguid="([^"]+)""#)
        .unwrap()
        .captures_iter(&xml)
        .map(|c| c[1].to_string())
        .collect();
    assert_eq!(guids.iter().collect::<HashSet<_>>().len(), guids.len());
}

#[test]
fn uncoded_video_transcript_stays_inline() {
    let video = with_transcript(
        json!({ "guid": VIDEO, "name": "Clip", "sourceType": "video", "formatData": { "videoExt": "mp4", "lineTimes": line_times() }, "selections": [] }),
        &[],
    );
    let xml = serialize_project(&project(vec![video], false), APP_VERSION);
    assert_eq!(xml.matches("<VideoSource").count(), 1);
    assert!(!xml.contains("<TextSource"));
    assert!(xml.contains("<Transcript"));
}

#[test]
fn pure_timeline_coding_is_still_a_video_selection() {
    let sels = vec![
        json!({ "guid": "D0000000-0000-4000-8000-000000000002", "startPosition": 0, "endPosition": 0,
                            "timeRange": { "startTime": 1, "endTime": 2 },
                            "codings": [{ "guid": "E0000000-0000-4000-8000-00000000000E", "codeGuid": CODE }] }),
    ];
    let video = with_transcript(
        json!({ "guid": VIDEO, "name": "Clip", "sourceType": "video", "formatData": { "videoExt": "mp4", "lineTimes": line_times() }, "selections": sels }),
        &sels,
    );
    let xml = serialize_project(&project(vec![video], true), APP_VERSION);
    assert!(
        regex::Regex::new(r#"<VideoSelection[^>]*guid="D0000000-0000-4000-8000-000000000002""#)
            .unwrap()
            .is_match(&xml)
    );
}

// ── Media-transcript reconciliation ──

fn paths(
    media: &[(&str, &str)],
    transcript: &[(&str, &str)],
    text: &[(&str, &str)],
) -> MediaTranscriptPaths {
    let m = |v: &[(&str, &str)]| {
        v.iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect::<HashMap<_, _>>()
    };
    MediaTranscriptPaths {
        media_path_by_guid: m(media),
        transcript_file_by_guid: m(transcript),
        text_file_by_guid: m(text),
    }
}

fn contents(pairs: &[(&str, &str)]) -> Map<String, Value> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), json!(v)))
        .collect()
}

#[test]
fn folds_atlas_transcript_into_one_video() {
    let t = "This is a video transcript.\nIt has a code here.";
    let sources = vec![
        json!({ "guid": "VID1", "sourceType": "video", "name": "Video.mp4", "selections": [] }),
        json!({ "guid": "TXT1", "sourceType": "text", "name": "Video-transcript",
                "selections": [{ "guid": "SEL1", "startPosition": 42, "endPosition": 46, "codings": [{ "guid": "C1", "codeGuid": "CODE" }] }] }),
        json!({ "guid": "VID2", "sourceType": "video", "name": "Video-transcript", "selections": [] }),
    ];
    let mut sc = contents(&[("TXT1", t), ("VID2", t)]);
    let media = "relative:///EF19F4F8.m4a";
    let result = reconcile_media_transcripts(
        sources,
        &mut sc,
        &paths(
            &[("VID1", media), ("VID2", media)],
            &[("VID2", "08029678.txt")],
            &[("TXT1", "08029678.txt")],
        ),
    );
    assert_eq!(result.len(), 1);
    assert_eq!(result[0]["guid"], "VID1");
    assert_eq!(sc["VID1"], t);
    assert_eq!(result[0]["selections"][0]["startPosition"], 42);
    assert_eq!(result[0]["selections"][0]["codings"][0]["codeGuid"], "CODE");
    assert!(!sc.contains_key("TXT1") && !sc.contains_key("VID2"));
}

#[test]
fn folded_coding_gets_a_time_range_from_line_times() {
    let t = "Line one is here.\nLine two is here.";
    let sources = vec![
        json!({ "guid": "V", "sourceType": "video", "name": "Clip.mp4", "formatData": { "lineTimes": { "0": 0, "1": 5 } }, "selections": [] }),
        json!({ "guid": "T", "sourceType": "text", "name": "Clip-transcript", "selections": [{ "guid": "S", "startPosition": 30, "endPosition": 34, "codings": [] }] }),
        json!({ "guid": "V2", "sourceType": "video", "name": "Clip-transcript", "selections": [] }),
    ];
    let mut sc = contents(&[("T", t), ("V2", t)]);
    let r = reconcile_media_transcripts(
        sources,
        &mut sc,
        &paths(&[("V", "p"), ("V2", "p")], &[("V2", "f")], &[("T", "f")]),
    );
    assert_eq!(r[0]["selections"][0]["timeRange"]["startTime"], 5);
}

#[test]
fn magnolia_native_media_is_untouched() {
    let sources = vec![
        json!({ "guid": "V", "sourceType": "video", "name": "Clip.mp4", "selections": [{ "guid": "S", "startPosition": 0, "endPosition": 5, "codings": [] }] }),
    ];
    let mut sc = contents(&[("V", "hello transcript")]);
    let r = reconcile_media_transcripts(
        sources.clone(),
        &mut sc,
        &paths(&[("V", "internal://V.mp4")], &[("V", "V.txt")], &[]),
    );
    assert_eq!(r, sources);
    assert_eq!(sc["V"], "hello transcript");
}

#[test]
fn video_coding_survives_full_round_trip() {
    let sels = vec![video_coding()];
    let video = with_transcript(
        json!({ "guid": VIDEO, "name": "Clip", "sourceType": "video", "formatData": { "videoExt": "mp4", "lineTimes": line_times() }, "selections": sels }),
        &sels,
    );
    let mut parsed =
        deserialize_project(&serialize_project(&project(vec![video], true), APP_VERSION)).unwrap();
    let sources = parsed["sources"].as_array_mut().unwrap();
    for s in sources.iter_mut() {
        if s["guid"] == VIDEO {
            s["formatData"] = json!({ "lineTimes": line_times() });
        }
    }
    let mut sc = Map::new();
    let mut p = MediaTranscriptPaths::default();
    let internal = |v: &Value| {
        v.as_str()
            .and_then(|s| s.strip_prefix("internal://"))
            .map(str::to_string)
    };
    for s in sources.iter() {
        let g = s["guid"].as_str().unwrap().to_string();
        if !s["selections"].as_array().unwrap().is_empty() || s.get("_refiTranscript").is_some() {
            sc.insert(g.clone(), json!(TEXT));
        }
        match s["sourceType"].as_str() {
            Some("audio" | "video") => {
                if let Some(path) = s["plainTextPath"].as_str() {
                    p.media_path_by_guid.insert(g.clone(), path.into());
                }
                if let Some(f) = s
                    .get("_refiTranscript")
                    .and_then(|t| internal(&t["plainTextPath"]))
                {
                    p.transcript_file_by_guid.insert(g, f);
                }
            }
            _ => {
                if let Some(f) = internal(&s["plainTextPath"]) {
                    p.text_file_by_guid.insert(g, f);
                }
            }
        }
    }
    let folded = reconcile_media_transcripts(sources.clone(), &mut sc, &p);
    assert_eq!(folded.len(), 1);
    let sel = &folded[0]["selections"][0];
    assert_eq!(folded[0]["guid"], VIDEO);
    assert_eq!(folded[0]["selections"].as_array().unwrap().len(), 1);
    assert_eq!(
        (sel["startPosition"].as_i64(), sel["endPosition"].as_i64()),
        (Some(12), Some(23))
    );
    assert_eq!(sel["codings"][0]["codeGuid"], CODE);
    assert!(sel.get("timeRange").is_some());
}

#[test]
fn reconcile_is_noop_without_transcript_references() {
    let sources = vec![
        json!({ "guid": "A", "sourceType": "text", "name": "Doc", "selections": [] }),
        json!({ "guid": "B", "sourceType": "video", "name": "Clip", "selections": [] }),
    ];
    let mut sc = contents(&[("A", "a"), ("B", "")]);
    let r = reconcile_media_transcripts(
        sources,
        &mut sc,
        &paths(&[("B", "internal://B.mp4")], &[], &[("A", "A.txt")]),
    );
    assert_eq!(r.len(), 2);
}

// ── Relationship maps ──

const DOC: &str = "D0CD0CD0-0000-4000-8000-00000000DD01";
const MAP_CODE: &str = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
const ELDOC: &str = "E1111111-1111-4111-8111-111111111111";
const ELCODE: &str = "E2222222-2222-4222-8222-222222222222";
const FT1: &str = "F1111111-1111-4111-8111-111111111111";
const CONN1: &str = "C1111111-1111-4111-8111-111111111111";

fn map_analysis() -> Value {
    json!({
        "guid": "A1111111-1111-4111-8111-111111111111", "toolType": "relationship-map", "name": "RelationshipMap",
        "createdDateTime": "2024-01-01T00:00:00Z",
        "config": {
            "pan": { "x": 0, "y": 0 },
            "elements": [
                { "id": ELDOC, "kind": "document", "label": "memohere.txt", "entityGuid": DOC, "x": 140, "y": 188, "width": 160, "height": 40 },
                { "id": ELCODE, "kind": "code", "label": "code", "entityGuid": MAP_CODE, "codeColor": "#e05050", "x": 334, "y": 336, "width": 160, "height": 28 }
            ],
            "freeTexts": [{ "id": FT1, "kind": "freetext", "x": 328, "y": 136, "width": 199, "height": 83, "content": "# Free text" }],
            "connections": [{ "id": CONN1, "fromId": ELDOC, "toId": ELCODE, "arrowFrom": false, "arrowTo": true, "label": "With a note" }]
        }
    })
}

fn project_with_map() -> Value {
    json!({ "name": "Graph Project", "origin": "Magnolia test",
            "users": [{ "guid": "00000000-0000-4000-8000-000000000001", "name": "T" }],
            "codes": [{ "guid": MAP_CODE, "name": "code", "isCodable": true, "children": [] }],
            "sources": [{ "guid": DOC, "name": "memohere.txt", "sourceType": "text", "plainTextContent": "hi", "selections": [] }],
            "sets": [], "notes": [], "savedAnalyses": [map_analysis()] })
}

#[test]
fn every_vertex_has_a_represented_guid() {
    let b = map_to_graph(&map_analysis());
    let vs = b.graphs[0]["vertices"].as_array().unwrap();
    assert_eq!(vs.len(), 3);
    assert!(vs.iter().all(|v| v.get("representedGuid").is_some()));
    assert_eq!(b.notes.len(), 1);
    assert_eq!(b.notes[0]["content"], "# Free text");
    let ft = vs.iter().find(|v| v["guid"] == FT1).unwrap();
    assert_eq!(ft["shape"], "Note");
    assert_eq!(ft["representedGuid"], b.notes[0]["guid"]);
}

#[test]
fn connection_becomes_link_and_edge() {
    let b = map_to_graph(&map_analysis());
    assert_eq!(b.links.len(), 1);
    assert_eq!(b.links[0]["originGuid"], DOC);
    assert_eq!(b.links[0]["targetGuid"], MAP_CODE);
    let edge = &b.graphs[0]["edges"][0];
    assert_eq!(edge["sourceVertex"], ELDOC);
    assert_eq!(edge["targetVertex"], ELCODE);
    assert_eq!(edge["representedGuid"], b.links[0]["guid"]);
    assert_ne!(edge["guid"], b.links[0]["guid"]);
}

#[test]
fn map_validates_against_xsd() {
    validate(&serialize_project(&project_with_map(), APP_VERSION)).unwrap();
}

#[test]
fn map_xml_has_atlas_shape() {
    let xml = serialize_project(&project_with_map(), APP_VERSION);
    assert!(xml.contains("<Links>") && xml.contains("<Link ") && xml.contains("<Edge"));
    assert!(
        regex::Regex::new(r"<Edge[^>]*representedGUID=")
            .unwrap()
            .is_match(&xml)
    );
    let vertices: Vec<&str> = regex::Regex::new(r"<Vertex[^>]*>")
        .unwrap()
        .find_iter(&xml)
        .map(|m| m.as_str())
        .collect();
    assert_eq!(vertices.len(), 3);
    assert!(vertices.iter().all(|v| v.contains("representedGUID=")));
    assert!(xml.contains("# Free text"));
}

#[test]
fn non_map_analyses_are_ignored() {
    let other = json!({ "guid": "B2222222-2222-4222-8222-222222222222", "toolType": "code-frequencies", "name": "Freqs", "createdDateTime": "", "config": {} });
    assert_eq!(collect_graphs(&[map_analysis(), other]).graphs.len(), 1);
}

#[test]
fn graph_to_map_without_context_uses_free_text() {
    let b = map_to_graph(&map_analysis());
    let a = graph_to_map(&b.graphs[0], &|_| None, &HashMap::new());
    assert_eq!(a["toolType"], "relationship-map");
    assert_eq!(a["config"]["freeTexts"].as_array().unwrap().len(), 3);
    let c = &a["config"]["connections"][0];
    assert_eq!(
        (
            c["fromId"].as_str(),
            c["toId"].as_str(),
            c["arrowTo"].as_bool()
        ),
        (Some(ELDOC), Some(ELCODE), Some(true))
    );
}

#[test]
fn graph_to_map_resolves_entities_and_link_labels() {
    let (v_doc, v_img, v_ano) = (
        "00C89D15-E069-4CEB-8948-9F3FB5A0CD4B",
        "A5B41962-05BF-4362-BBC4-8EE6D5321FD8",
        "B13D707F-019E-4D1B-857C-C8B670029955",
    );
    let (img, ano, link) = (
        "2A08BDDF-4C35-4250-BF77-7DE37B50C930",
        "2D969AF8-C875-4FAE-BCD8-F0162BC27396",
        "9FD0FA13-196E-4A0C-9D8C-CC779CA24766",
    );
    let graph = json!({
        "guid": "G0000000-0000-4000-8000-000000000001", "name": "Relationship Map",
        "vertices": [
            { "guid": v_doc, "representedGuid": DOC, "name": "magnoliasolid.png", "firstX": 231, "firstY": 97, "secondX": 391, "secondY": 194, "shape": "Rectangle" },
            { "guid": v_img, "representedGuid": img, "name": "image", "firstX": 31, "firstY": 239, "secondX": 191, "secondY": 302, "shape": "Rectangle" },
            { "guid": v_ano, "representedGuid": ano, "name": "another", "firstX": 378, "firstY": 240, "secondX": 538, "secondY": 303, "shape": "Rectangle" }
        ],
        "edges": [{ "guid": "AFFE2E91-FF08-4DF9-98E5-41E42CC300A3", "representedGuid": link, "sourceVertex": v_ano, "targetVertex": v_img, "direction": "Bidirectional", "lineStyle": "solid" }]
    });
    let links: HashMap<String, Value> =
        [(link.to_string(), json!({ "guid": link, "name": "contradicts", "direction": "Bidirectional", "originGuid": ano, "targetGuid": img }))].into();
    let resolve = |g: &str| -> Option<GraphEntity> {
        match g {
            DOC => Some(GraphEntity {
                kind: "document",
                label: "magnoliasolid.png".into(),
                code_color: None,
                source_type: Some("image".into()),
            }),
            g if g == img => Some(GraphEntity {
                kind: "code",
                label: "image".into(),
                code_color: Some("#E05050".into()),
                source_type: None,
            }),
            g if g == ano => Some(GraphEntity {
                kind: "code",
                label: "another".into(),
                code_color: Some("#E08050".into()),
                source_type: None,
            }),
            _ => None,
        }
    };
    let a = graph_to_map(&graph, &resolve, &links);
    let els = a["config"]["elements"].as_array().unwrap();
    assert_eq!(els.len(), 3);
    assert!(a["config"]["freeTexts"].as_array().unwrap().is_empty());
    let doc = els.iter().find(|e| e["entityGuid"] == DOC).unwrap();
    assert_eq!(
        (doc["kind"].as_str(), doc["sourceType"].as_str()),
        (Some("document"), Some("image"))
    );
    let code = els.iter().find(|e| e["label"] == "image").unwrap();
    assert_eq!(
        (code["kind"].as_str(), code["codeColor"].as_str()),
        (Some("code"), Some("#E05050"))
    );
    assert_eq!(
        (
            code["width"].as_i64(),
            code["height"].as_i64(),
            doc["height"].as_i64()
        ),
        (Some(160), Some(28), Some(28))
    );
    assert_eq!(
        (doc["x"].as_i64(), doc["y"].as_i64()),
        (Some(231), Some(97))
    );
    let c = &a["config"]["connections"][0];
    assert_eq!(
        (
            c["label"].as_str(),
            c["arrowFrom"].as_bool(),
            c["arrowTo"].as_bool()
        ),
        (Some("contradicts"), Some(true), Some(true))
    );
}
