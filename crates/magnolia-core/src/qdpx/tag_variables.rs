//! Tags in a category as the REFI-QDA standard's variables.
//!
//! A tag category is an attribute ("Student type") and each of its tags a
//! value of it ("Domestic"): what the standard calls a variable, "a named
//! attribute of a case or a source with a value" (§3.18). So, in the file:
//! - a category is a `<Variable>`, with the category's own guid;
//! - each tag on a document is a `<VariableValue>` on that document (one
//!   per tag: a document can carry several of a category's tags, as a
//!   paper has several authors, and the schema lets values repeat);
//! - each tag on a survey respondent is a `<VariableValue>` on the
//!   respondent's `<Case>`.
//!
//! A tag without a category is a plain group of documents, which is what
//! the standard's `<Set>` is, and stays one. A tag on a survey question has
//! no place in the standard and stays in Magnolia's side file.
//!
//! Every category's record in `magnolia-tags.json` also carries its tags
//! whole (`tags`): what Magnolia reads them back from. Magnolia 2.2 and
//! earlier read tags only from `<Set>`s, so they don't see these tags; but
//! they write a category's record back as they read it, so when one of
//! them has saved the file, the tags come back on the next opening here.

use crate::util::{get_arr, get_nonempty, get_str, normalize_guid, num, truthy};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

/// The field of a category's record in `magnolia-tags.json` that carries
/// its tags.
pub const BACKUP_FIELD: &str = "tags";

/// What a project's categorised tags write as variables.
#[derive(Default)]
pub struct TagVariables {
    /// `<Variable>`s: one per category that has a tag on something.
    pub variables: Vec<Value>,
    /// Values on each document, by its guid (normalized).
    pub on_document: HashMap<String, Vec<Value>>,
    /// Values on each survey respondent, by (survey guid normalized, id).
    pub on_respondent: HashMap<(String, String), Vec<Value>>,
    /// The tags written as variables (normalized guids): not also sets.
    categorised: HashSet<String>,
}

/// A tag's category, if it has one that exists.
fn category_of<'a>(tag: &Value, categories: &'a [Value]) -> Option<&'a Value> {
    let g = normalize_guid(get_nonempty(tag, "categoryGuid"));
    if g.is_empty() {
        return None;
    }
    categories.iter().find(|c| normalize_guid(get_str(c, "guid")) == g)
}

/// The value a tag gives its category: its value, else its name.
fn tag_value(tag: &Value) -> String {
    get_nonempty(tag, "value")
        .or_else(|| get_nonempty(tag, "name"))
        .unwrap_or("")
        .trim()
        .to_string()
}

impl TagVariables {
    pub fn of(project: &Value) -> Self {
        let categories = get_arr(project, "tagCategories");
        let tags = get_arr(project, "sets");
        let mut out = TagVariables::default();
        for cat in categories {
            let cat_guid = get_str(cat, "guid").unwrap_or("");
            let mine: Vec<&Value> = tags
                .iter()
                .filter(|t| category_of(t, categories).is_some_and(|c| std::ptr::eq(c, cat)))
                .collect();
            for t in &mine {
                out.categorised.insert(normalize_guid(get_str(t, "guid")));
            }
            // A number category whose values are all numbers is numeric;
            // anything else (dates included, which can be partial) is text.
            let numeric = get_str(cat, "type") == Some("numeric")
                && mine.iter().all(|t| tag_value(t).replace(',', "").parse::<f64>().is_ok_and(f64::is_finite));
            let value_of = |t: &Value| -> Option<Value> {
                let v = tag_value(t);
                if v.is_empty() {
                    return None;
                }
                Some(if numeric {
                    json!({ "variableGuid": cat_guid, "floatValue": num(v.replace(',', "").parse::<f64>().unwrap()) })
                } else {
                    json!({ "variableGuid": cat_guid, "textValue": v })
                })
            };
            let mut used = false;
            for t in &mine {
                let Some(value) = value_of(t) else { continue };
                for d in get_arr(t, "memberSourceGuids") {
                    if let Some(d) = d.as_str() {
                        out.on_document.entry(normalize_guid(Some(d))).or_default().push(value.clone());
                        used = true;
                    }
                }
                for r in get_arr(t, "memberSurveyRespondents") {
                    if let (Some(s), Some(id)) = (get_str(r, "sourceGuid"), get_str(r, "id")) {
                        out.on_respondent
                            .entry((normalize_guid(Some(s)), id.to_string()))
                            .or_default()
                            .push(value.clone());
                        used = true;
                    }
                }
            }
            if used {
                out.variables.push(json!({
                    "guid": cat_guid,
                    "name": get_str(cat, "name").unwrap_or(""),
                    "typeOfVariable": if numeric { "Float" } else { "Text" },
                }));
            }
        }
        out
    }

    /// Whether this tag is written as a variable (so not as a set).
    pub fn is_categorised(&self, tag: &Value) -> bool {
        self.categorised.contains(&normalize_guid(get_str(tag, "guid")))
    }
}

/// The categories for `magnolia-tags.json`: each with its tags whole.
pub fn categories_with_backup(project: &Value) -> Vec<Value> {
    let categories = get_arr(project, "tagCategories");
    let tags = get_arr(project, "sets");
    categories
        .iter()
        .map(|cat| {
            let mut c = cat.clone();
            let mine: Vec<Value> = tags
                .iter()
                .filter(|t| category_of(t, categories).is_some_and(|x| std::ptr::eq(x, cat)))
                .cloned()
                .collect();
            if let Some(o) = c.as_object_mut() {
                o.remove(BACKUP_FIELD);
                if !mine.is_empty() {
                    o.insert(BACKUP_FIELD.into(), mine.into());
                }
            }
            c
        })
        .collect()
}

/// The guids of the categories in `magnolia-tags.json` (normalized): the
/// file's variables with these guids are Magnolia's own tags, not another
/// program's variables to read as tags.
pub fn own_variable_guids(project: &Value) -> HashSet<String> {
    get_arr(project, "tagCategories")
        .iter()
        .filter_map(|c| get_str(c, "guid"))
        .map(|g| normalize_guid(Some(g)))
        .collect()
}

/// Read: each category's tags from its record, into the project's tags
/// (`sets`). Their documents, respondents, questions and codes are kept if
/// they're still in the project (a version of Magnolia that couldn't see
/// these tags may have deleted some). A tag of the same category and value
/// already there (made in such a version) is the same tag: the two are
/// merged. The records lose the field, so it's only ever written afresh.
pub fn restore_from_backup(project: &mut Value) {
    let Some(categories) = project.get("tagCategories").and_then(Value::as_array).cloned() else {
        return;
    };
    if !categories.iter().any(|c| c.get(BACKUP_FIELD).is_some_and(Value::is_array)) {
        return;
    }
    let ids = |key: &str| -> HashSet<String> {
        get_arr(project, key)
            .iter()
            .filter_map(|x| get_str(x, "guid"))
            .map(|g| normalize_guid(Some(g)))
            .collect()
    };
    let documents = ids("sources");
    let mut codes = HashSet::new();
    fn walk(codes: &[Value], out: &mut HashSet<String>) {
        for c in codes {
            if let Some(g) = get_str(c, "guid") {
                out.insert(normalize_guid(Some(g)));
            }
            walk(get_arr(c, "children"), out);
        }
    }
    walk(get_arr(project, "codes"), &mut codes);
    // Each survey's respondents and questions.
    let mut respondents: HashSet<(String, String)> = HashSet::new();
    let mut questions: HashSet<(String, String)> = HashSet::new();
    for s in get_arr(project, "sources") {
        let Some(survey) = s.get("formatData").and_then(|f| f.get("survey")).filter(|v| truthy(v)) else {
            continue;
        };
        let sg = normalize_guid(get_str(s, "guid"));
        for r in get_arr(survey, "respondents") {
            if let Some(id) = get_str(r, "id") {
                respondents.insert((sg.clone(), id.to_string()));
            }
        }
        for q in get_arr(survey, "questions") {
            if let Some(id) = get_str(q, "id") {
                questions.insert((sg.clone(), id.to_string()));
            }
        }
    }
    let keep_ids = |arr: &[Value], known: &HashSet<String>| -> Vec<Value> {
        arr.iter()
            .filter(|g| g.as_str().is_some_and(|g| known.contains(&normalize_guid(Some(g)))))
            .cloned()
            .collect()
    };
    let keep_entities = |arr: &[Value], known: &HashSet<(String, String)>| -> Vec<Value> {
        arr.iter()
            .filter(|m| {
                let key = (normalize_guid(get_str(m, "sourceGuid")), get_str(m, "id").unwrap_or("").to_string());
                known.contains(&key)
            })
            .cloned()
            .collect()
    };

    let mut sets: Vec<Value> = get_arr(project, "sets").to_vec();
    for cat in &categories {
        let cat_guid = normalize_guid(get_str(cat, "guid"));
        // A tag is an object; anything else is from a fault or a crafted
        // file, and is skipped rather than crash the read.
        for backup in get_arr(cat, BACKUP_FIELD).iter().filter(|t| t.is_object()) {
            let mut tag = backup.clone();
            tag["memberSourceGuids"] = keep_ids(get_arr(backup, "memberSourceGuids"), &documents).into();
            tag["memberCodeGuids"] = keep_ids(get_arr(backup, "memberCodeGuids"), &codes).into();
            for (k, known) in [("memberSurveyRespondents", &respondents), ("memberSurveyQuestions", &questions)] {
                if backup.get(k).is_some() {
                    tag[k] = keep_entities(get_arr(backup, k), known).into();
                }
            }
            let guid = normalize_guid(get_str(&tag, "guid"));
            let value = tag_value(&tag).to_lowercase();
            // The same tag (by guid), or one made again in an older version
            // (same category and value): merged into this one.
            let same: Vec<usize> = sets
                .iter()
                .enumerate()
                .filter(|(_, s)| {
                    normalize_guid(get_str(s, "guid")) == guid
                        || (normalize_guid(get_nonempty(s, "categoryGuid")) == cat_guid && tag_value(s).to_lowercase() == value)
                })
                .map(|(i, _)| i)
                .collect();
            for &i in same.iter().rev() {
                let other = sets.remove(i);
                for k in ["memberSourceGuids", "memberCodeGuids"] {
                    let list = tag[k].as_array_mut().unwrap();
                    for g in get_arr(&other, k) {
                        if !list.iter().any(|x| x.as_str().map(|x| normalize_guid(Some(x))) == g.as_str().map(|g| normalize_guid(Some(g)))) {
                            list.push(g.clone());
                        }
                    }
                }
                for k in ["memberSurveyRespondents", "memberSurveyQuestions"] {
                    for m in get_arr(&other, k) {
                        if !tag.get(k).is_some_and(Value::is_array) {
                            tag[k] = json!([]);
                        }
                        let list = tag[k].as_array_mut().unwrap();
                        if !list.iter().any(|x| get_str(x, "sourceGuid") == get_str(m, "sourceGuid") && get_str(x, "id") == get_str(m, "id")) {
                            list.push(m.clone());
                        }
                    }
                }
            }
            sets.push(tag);
        }
    }
    project["sets"] = sets.into();
    if let Some(cats) = project.get_mut("tagCategories").and_then(Value::as_array_mut) {
        for c in cats {
            if let Some(o) = c.as_object_mut() {
                o.remove(BACKUP_FIELD);
            }
        }
    }
}
