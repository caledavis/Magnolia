//! REFI-QDA Codebook (.qdc) import/export — the code hierarchy, colours and
//! descriptions only (`urn:QDA-XML:codebook:1.0`).

use super::serializer::codes_xml;
use crate::util::normalize_guid;
use crate::xml_build::{El, document, uppercase_guids};
use crate::xml_read::{attr, child_text, children, list};
use serde_json::{Map, Value};

pub fn serialize_codebook(codes: &[Value], app_version: &str) -> String {
    let mut root = El::new("CodeBook")
        .attr("xmlns", "urn:QDA-XML:codebook:1.0")
        .attr("origin", format!("Magnolia {app_version}"));
    if !codes.is_empty() {
        let mut c = El::new("Codes");
        c.children = codes_xml(codes);
        root.push(c);
    }
    let xml = document(&[("version", "1.0"), ("encoding", "utf-8")], &root);
    uppercase_guids(
        &xml,
        "guid|targetGUID|creatingUser(?:GUID)?|modifyingUser(?:GUID)?",
    )
}

fn parse_code(n: roxmltree::Node) -> Value {
    let mut o = Map::new();
    o.insert(
        "guid".into(),
        normalize_guid(attr(n, "guid").as_deref()).into(),
    );
    o.insert("name".into(), attr(n, "name").unwrap_or_default().into());
    o.insert(
        "isCodable".into(),
        (attr(n, "isCodable").as_deref() != Some("false")).into(),
    );
    crate::util::set_opt(&mut o, "color", attr(n, "color"));
    crate::util::set_opt(&mut o, "description", child_text(n, "Description"));
    o.insert(
        "children".into(),
        children(n, "Code")
            .map(parse_code)
            .collect::<Vec<_>>()
            .into(),
    );
    Value::Object(o)
}

pub fn deserialize_codebook(xml: &str) -> Result<Vec<Value>, String> {
    let xml = crate::xml_read::repair_if_needed(xml);
    let doc = crate::xml_read::parse(&xml).map_err(|e| format!("Invalid codebook XML: {e}"))?;
    let root = doc.root_element();
    if root.tag_name().name() != "CodeBook" {
        return Ok(vec![]);
    }
    Ok(list(root, &["Codes", "Code"])
        .into_iter()
        .map(parse_code)
        .collect())
}
