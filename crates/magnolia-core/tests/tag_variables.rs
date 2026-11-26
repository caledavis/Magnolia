//! Tags in a category written as the standard's variables (tag_variables.rs):
//! the file says what it should, reads back the same, and the tags come back
//! after a Magnolia that can't see them (2.2 and earlier) has saved it.
mod common;
use common::*;
use magnolia_core::qdpx::reader::read_qdpx;
use magnolia_core::qdpx::writer::{WriteOptions, write_qdpx};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// The end-to-end sample: tags in "Student type" on documents and on survey
/// respondents, and "Followed up" with no category.
fn sample() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../e2e/fixture/sample.qdpx")
}

fn save(project: &Value, path: &Path) {
    let mut p = project.clone();
    let contents: Map<String, Value> = p.as_object_mut().unwrap().remove("sourceContents").and_then(|c| c.as_object().cloned()).unwrap_or_default();
    let opts = WriteOptions { app_version: "0.0.0-test", editor_name: "", ..Default::default() };
    write_qdpx(path, &mut p, &contents, &opts).unwrap();
}

/// Each tag: (name, category, value, documents, respondents), by guid.
type Tags = BTreeMap<String, (String, String, String, Vec<String>, Vec<String>)>;
fn tags(project: &Value) -> Tags {
    let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_uppercase();
    project["sets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| {
            let mut docs: Vec<String> = t["memberSourceGuids"].as_array().map(|a| a.iter().map(|g| g.as_str().unwrap().to_uppercase()).collect()).unwrap_or_default();
            docs.sort();
            let mut resp: Vec<String> = t.get("memberSurveyRespondents").and_then(Value::as_array).map(|a| a.iter().map(|m| format!("{}/{}", s(m, "sourceGuid"), m["id"].as_str().unwrap())).collect()).unwrap_or_default();
            resp.sort();
            (s(t, "guid"), (t["name"].as_str().unwrap_or("").into(), s(t, "categoryGuid"), t.get("value").and_then(Value::as_str).unwrap_or("").into(), docs, resp))
        })
        .collect()
}

fn qde(path: &Path) -> String {
    let mut z = zip::ZipArchive::new(std::fs::File::open(path).unwrap()).unwrap();
    let name = (0..z.len()).map(|i| z.name_for_index(i).unwrap().unwrap().to_string()).find(|n| n.ends_with(".qde")).unwrap();
    let mut s = String::new();
    z.by_name(&name).unwrap().read_to_string(&mut s).unwrap();
    // Without the indentation between elements, for matching.
    s.lines().map(str::trim).collect()
}

/// Rewrite one entry of the archive (as another program, or an older
/// Magnolia, would have written it).
fn rewrite_entry(path: &Path, name: &str, f: impl Fn(String) -> String) {
    let mut z = zip::ZipArchive::new(std::fs::File::open(path).unwrap()).unwrap();
    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    for i in 0..z.len() {
        let mut e = z.by_index(i).unwrap();
        let mut b = Vec::new();
        e.read_to_end(&mut b).unwrap();
        let n = e.name().map(|n| n.to_string()).unwrap();
        if n == name || (name == ".qde" && n.ends_with(".qde")) {
            let text = String::from_utf8(b).unwrap();
            let text = if name == ".qde" { text.lines().map(str::trim).collect() } else { text };
            b = f(text).into_bytes();
        }
        entries.push((n, b));
    }
    drop(z);
    let mut w = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
    for (n, b) in entries {
        w.start_file(n, zip::write::SimpleFileOptions::default()).unwrap();
        w.write_all(&b).unwrap();
    }
    w.finish().unwrap();
}

#[test]
fn a_category_is_a_variable_and_its_tags_values() {
    let dir = temp();
    let original = read_qdpx(&sample(), None).unwrap();
    let out = p(&dir, "out.qdpx");
    save(&original, &out);
    let xml = qde(&out);
    validate(&xml).unwrap();

    // "Student type" is a variable with the category's own guid…
    let cat = original["tagCategories"][0]["guid"].as_str().unwrap().to_uppercase();
    assert!(xml.contains(&format!(r#"<Variable guid="{cat}" name="Student type" typeOfVariable="Text"/>"#)), "{xml}");
    // …its tags are values on documents and on respondents' cases…
    let on_documents = xml.split("<TextSource").filter(|s| s.contains(&format!(r#"<VariableRef targetGUID="{cat}"/>"#))).count();
    let on_cases = xml.split("<Case ").filter(|s| s.contains(&format!(r#"<VariableRef targetGUID="{cat}"/>"#))).count();
    assert!(on_documents > 0 && on_cases > 0, "documents {on_documents}, cases {on_cases}");
    // …not sets; the tag without a category still is one.
    assert!(!xml.contains(r#"name="Domestic""#));
    assert!(xml.contains(r#"<Set guid="F22956E5-75CB-4314-93F5-460496B50BB1" name="Followed up">"#));

    // Read back: the same tags, and no others (the variables aren't read as
    // another program's), and the same categories.
    let back = read_qdpx(&out, None).unwrap();
    assert_eq!(tags(&back), tags(&original));
    assert_eq!(back["tagCategories"].as_array().unwrap().len(), original["tagCategories"].as_array().unwrap().len());
    assert!(back["tagCategories"][0].get("tags").is_none(), "the backup isn't kept in memory");
}

#[test]
fn tags_come_back_after_an_older_magnolia_saved_the_file() {
    let dir = temp();
    let original = read_qdpx(&sample(), None).unwrap();
    let out = p(&dir, "out.qdpx");
    save(&original, &out);
    let cat = original["tagCategories"][0]["guid"].as_str().unwrap().to_uppercase();

    // Magnolia 2.2 keeps the category records as they are, but drops what it
    // doesn't read: the variables and their values. And someone there made
    // "Domestic" again (a set, with its category in tagMeta) on a document.
    let doc = original["sources"].as_array().unwrap().iter().find(|s| s.get("sourceType").is_none() || s["sourceType"] == "text").unwrap()["guid"].as_str().unwrap().to_uppercase();
    rewrite_entry(&out, ".qde", |x| {
        let x = regex_lite_strip(&x, &cat);
        x.replace("</Sets>", &format!(r#"<Set guid="AAAAAAAA-0000-4000-8000-000000000001" name="Domestic"><MemberSource targetGUID="{doc}"/></Set></Sets>"#))
    });
    rewrite_entry(&out, "magnolia-tags.json", |j| {
        let mut v: Value = serde_json::from_str(&j).unwrap();
        v["tagMeta"].as_array_mut().unwrap().push(serde_json::json!({ "guid": "AAAAAAAA-0000-4000-8000-000000000001", "categoryGuid": cat, "value": "Domestic" }));
        v.to_string()
    });
    assert!(!qde(&out).contains(&cat), "the variable and its values are gone, as 2.2 leaves the file");

    let back = read_qdpx(&out, None).unwrap();
    let mut want = tags(&original);
    // The "Domestic" made again is the same tag: merged, its document added.
    let domestic = want.values_mut().find(|t| t.2 == "Domestic").unwrap();
    if !domestic.3.contains(&doc) {
        domestic.3.push(doc.clone());
        domestic.3.sort();
    }
    assert_eq!(tags(&back), want);
}

/// The file's XML without the variable `guid` and its values.
fn regex_lite_strip(xml: &str, guid: &str) -> String {
    let mut out = String::new();
    let mut rest = xml;
    let value = format!(r#"<VariableValue><VariableRef targetGUID="{guid}"/>"#);
    while let Some(i) = rest.find(&value) {
        out.push_str(&rest[..i]);
        let end = rest[i..].find("</VariableValue>").unwrap() + i + "</VariableValue>".len();
        rest = &rest[end..];
    }
    out.push_str(rest);
    let var = format!(r#"<Variable guid="{guid}""#);
    if let Some(i) = out.find(&var) {
        let end = out[i..].find("/>").unwrap() + i + 2;
        out.replace_range(i..end, "");
    }
    out.replace("<Variables></Variables>", "")
}

#[test]
fn a_document_can_have_several_values_of_a_category() {
    let dir = temp();
    let mut project = read_qdpx(&sample(), None).unwrap();
    let doc = project["sources"][0]["guid"].as_str().unwrap().to_string();
    // Put the first document in every "Student type" tag.
    for t in project["sets"].as_array_mut().unwrap() {
        if t.get("categoryGuid").is_some() {
            let members = t["memberSourceGuids"].as_array_mut().unwrap();
            if !members.iter().any(|m| m.as_str() == Some(doc.as_str())) {
                members.push(doc.clone().into());
            }
        }
    }
    let out = p(&dir, "out.qdpx");
    save(&project, &out);
    let xml = qde(&out);
    validate(&xml).unwrap();
    let cat = project["tagCategories"][0]["guid"].as_str().unwrap().to_uppercase();
    let element = xml.split("<TextSource").find(|s| s.contains(&doc.to_uppercase())).unwrap();
    assert_eq!(element.matches(&format!(r#"<VariableRef targetGUID="{cat}"/>"#)).count(), 3, "{element}");
    assert_eq!(tags(&read_qdpx(&out, None).unwrap()), tags(&project));
}
