//! Relationship Map ⇄ REFI-QDA `<Graphs>` interop.
//!
//! A relationship map is a SavedAnalysis (`toolType: 'relationship-map'`)
//! whose config holds elements, free-text boxes and connections. The full map
//! round-trips via `magnolia-analyses.json`; this module additionally emits
//! the standards-native `<Graph>` (plus the `<Link>`s its edges represent and
//! synthetic `<Note>`s backing free-text boxes) so maps survive other tools,
//! and rebuilds a lossy map from a `<Graph>` when the side table is missing.

use crate::util::{Obj, flip_first_nibble, get_arr, get_f64, get_str, num, set_opt};
use regex::Regex;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

static GUID_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^\{?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}?$",
    )
    .unwrap()
});
static RGB_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$").unwrap());

/// Only emit a representedGUID / colour that satisfies the schema pattern.
fn as_guid(v: Option<&str>) -> Option<String> {
    v.filter(|s| GUID_RE.is_match(s)).map(str::to_string)
}
fn as_rgb(v: Option<&str>) -> Option<String> {
    v.filter(|s| RGB_RE.is_match(s)).map(str::to_string)
}

pub struct GraphBundle {
    pub graphs: Vec<Value>,
    pub links: Vec<Value>,
    pub notes: Vec<Value>,
}

/// First non-empty line of a free-text box, for its backing note's name.
fn first_line(content: &str) -> String {
    let heading = Regex::new(r"^#+\s*").unwrap();
    content
        .split('\n')
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(|l| heading.replace(l, "").chars().take(80).collect())
        .unwrap_or_else(|| "Free text".into())
}

/// Translate a connection's arrow flags into a REFI direction, swapping the
/// endpoints when the only arrow points back at the source.
fn direction_for(c: &Value) -> (String, String, &'static str) {
    let from = get_str(c, "fromId").unwrap_or("").to_string();
    let to = get_str(c, "toId").unwrap_or("").to_string();
    let af = c.get("arrowFrom").is_some_and(crate::util::truthy);
    let at = c.get("arrowTo").is_some_and(crate::util::truthy);
    match (af, at) {
        (true, true) => (from, to, "Bidirectional"),
        (false, true) => (from, to, "OneWay"),
        (true, false) => (to, from, "OneWay"),
        (false, false) => (from, to, "Associative"),
    }
}

pub fn map_to_graph(analysis: &Value) -> GraphBundle {
    let config = analysis.get("config").cloned().unwrap_or(json!({}));
    let mut notes = Vec::new();
    let mut represented: HashMap<String, String> = HashMap::new();
    let mut vertices = Vec::new();
    let f = |v: &Value, k: &str| get_f64(v, k).unwrap_or(f64::NAN);

    for el in get_arr(&config, "elements") {
        let id = get_str(el, "id").unwrap_or("").to_string();
        let rep = as_guid(get_str(el, "entityGuid"));
        if let Some(r) = &rep {
            represented.insert(id.clone(), r.clone());
        }
        let mut o = Obj::new();
        o.insert("guid".into(), id.into());
        set_opt(&mut o, "representedGuid", rep);
        set_opt(&mut o, "name", el.get("label").cloned());
        o.insert("firstX".into(), num(f(el, "x")));
        o.insert("firstY".into(), num(f(el, "y")));
        o.insert("secondX".into(), num(f(el, "x") + f(el, "width")));
        o.insert("secondY".into(), num(f(el, "y") + f(el, "height")));
        o.insert("shape".into(), "RoundedRectangle".into());
        set_opt(&mut o, "color", as_rgb(get_str(el, "codeColor")));
        vertices.push(Value::Object(o));
    }
    for ft in get_arr(&config, "freeTexts") {
        let id = get_str(ft, "id").unwrap_or("").to_string();
        let note_guid = flip_first_nibble(&id, true);
        let content = get_str(ft, "content").unwrap_or("").to_string();
        notes.push(json!({ "guid": note_guid, "name": first_line(&content), "content": content }));
        represented.insert(id.clone(), note_guid.clone());
        let mut o = Obj::new();
        o.insert("guid".into(), id.into());
        o.insert("representedGuid".into(), note_guid.into());
        set_opt(&mut o, "name", ft.get("content").cloned());
        o.insert("firstX".into(), num(f(ft, "x")));
        o.insert("firstY".into(), num(f(ft, "y")));
        o.insert("secondX".into(), num(f(ft, "x") + f(ft, "width")));
        o.insert("secondY".into(), num(f(ft, "y") + f(ft, "height")));
        o.insert("shape".into(), "Note".into());
        vertices.push(Value::Object(o));
    }

    let vertex_ids: HashSet<String> = vertices
        .iter()
        .filter_map(|v| get_str(v, "guid").map(str::to_string))
        .collect();
    let mut links = Vec::new();
    let mut edges = Vec::new();
    for c in get_arr(&config, "connections") {
        let from = get_str(c, "fromId").unwrap_or("");
        let to = get_str(c, "toId").unwrap_or("");
        if !vertex_ids.contains(from) || !vertex_ids.contains(to) {
            continue;
        }
        let (source, target, direction) = direction_for(c);
        let cid = get_str(c, "id").unwrap_or("").to_string();
        let label = get_str(c, "label")
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let mut edge = Obj::new();
        edge.insert("guid".into(), cid.clone().into());
        set_opt(&mut edge, "name", label.clone());
        edge.insert("sourceVertex".into(), source.clone().into());
        edge.insert("targetVertex".into(), target.clone().into());
        edge.insert("direction".into(), direction.into());
        edge.insert("lineStyle".into(), "solid".into());
        if let (Some(og), Some(tg)) = (represented.get(&source), represented.get(&target)) {
            let link_guid = flip_first_nibble(&cid, true);
            let mut l = Obj::new();
            l.insert("guid".into(), link_guid.clone().into());
            set_opt(&mut l, "name", label);
            l.insert("direction".into(), direction.into());
            l.insert("originGuid".into(), og.clone().into());
            l.insert("targetGuid".into(), tg.clone().into());
            links.push(Value::Object(l));
            edge.insert("representedGuid".into(), link_guid.into());
        }
        edges.push(Value::Object(edge));
    }

    let mut g = Obj::new();
    g.insert(
        "guid".into(),
        analysis.get("guid").cloned().unwrap_or(Value::Null),
    );
    set_opt(&mut g, "name", analysis.get("name").cloned());
    g.insert("vertices".into(), vertices.into());
    g.insert("edges".into(), edges.into());
    GraphBundle {
        graphs: vec![Value::Object(g)],
        links,
        notes,
    }
}

pub fn collect_graphs(saved_analyses: &[Value]) -> GraphBundle {
    let mut out = GraphBundle {
        graphs: vec![],
        links: vec![],
        notes: vec![],
    };
    for a in saved_analyses {
        if get_str(a, "toolType") != Some("relationship-map") {
            continue;
        }
        let b = map_to_graph(a);
        out.graphs.extend(b.graphs);
        out.links.extend(b.links);
        out.notes.extend(b.notes);
    }
    out
}

/// A project entity a vertex's representedGUID resolves to.
pub struct GraphEntity {
    pub kind: &'static str,
    pub label: String,
    pub code_color: Option<String>,
    pub source_type: Option<String>,
}

/// Magnolia's native node dimensions for the kinds `graph_to_map` produces.
fn entity_dims(kind: &str) -> (f64, f64) {
    match kind {
        "memo" => (220.0, 116.0),
        _ => (160.0, 28.0),
    }
}

/// Rebuild a relationship-map SavedAnalysis from a `<Graph>`, for files that
/// arrive without the side table.
pub fn graph_to_map(
    graph: &Value,
    resolve_entity: &dyn Fn(&str) -> Option<GraphEntity>,
    links: &HashMap<String, Value>,
) -> Value {
    let mut elements = Vec::new();
    let mut free_texts = Vec::new();
    for v in get_arr(graph, "vertices") {
        let x = get_f64(v, "firstX").unwrap_or(0.0);
        let y = get_f64(v, "firstY").unwrap_or(0.0);
        let width = get_f64(v, "secondX")
            .map(|sx| (sx - x).max(40.0))
            .unwrap_or(160.0);
        let height = get_f64(v, "secondY")
            .map(|sy| (sy - y).max(24.0))
            .unwrap_or(28.0);
        let guid = v.get("guid").cloned().unwrap_or(Value::Null);
        let rep = get_str(v, "representedGuid");
        match rep.and_then(resolve_entity) {
            Some(e) => {
                let (w, h) = entity_dims(e.kind);
                let mut el = Obj::new();
                el.insert("id".into(), guid);
                el.insert("kind".into(), e.kind.into());
                el.insert("label".into(), e.label.into());
                el.insert("entityGuid".into(), rep.unwrap().into());
                el.insert("x".into(), num(x));
                el.insert("y".into(), num(y));
                el.insert("width".into(), num(w));
                el.insert("height".into(), num(h));
                set_opt(&mut el, "codeColor", e.code_color.filter(|s| !s.is_empty()));
                set_opt(
                    &mut el,
                    "sourceType",
                    e.source_type.filter(|s| !s.is_empty()),
                );
                elements.push(Value::Object(el));
            }
            None => free_texts.push(json!({
                "id": guid, "kind": "freetext", "x": num(x), "y": num(y),
                "width": num(width), "height": num(height),
                "content": get_str(v, "name").unwrap_or(""),
            })),
        }
    }
    let connections: Vec<Value> = get_arr(graph, "edges")
        .iter()
        .map(|e| {
            let link = get_str(e, "representedGuid").and_then(|g| links.get(g));
            let direction =
                get_str(e, "direction").or_else(|| link.and_then(|l| get_str(l, "direction")));
            let label = get_str(e, "name")
                .filter(|s| !s.is_empty())
                .or_else(|| {
                    link.and_then(|l| get_str(l, "name"))
                        .filter(|s| !s.is_empty())
                })
                .unwrap_or("");
            json!({
                "id": e.get("guid"),
                "fromId": e.get("sourceVertex"),
                "toId": e.get("targetVertex"),
                "arrowFrom": direction == Some("Bidirectional"),
                "arrowTo": direction == Some("OneWay") || direction == Some("Bidirectional"),
                "label": label,
            })
        })
        .collect();
    json!({
        "guid": graph.get("guid"),
        "toolType": "relationship-map",
        "name": get_str(graph, "name").filter(|s| !s.is_empty()).unwrap_or("Imported Map"),
        "config": { "elements": elements, "freeTexts": free_texts, "connections": connections, "pan": { "x": 0, "y": 0 } },
        "createdDateTime": "",
    })
}
