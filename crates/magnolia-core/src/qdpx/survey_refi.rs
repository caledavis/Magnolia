//! Survey ⇄ REFI-QDA Variables / Cases / per-respondent documents.
//!
//! A Magnolia survey is one source plus a side table holding the parsed
//! `SurveyData`. Other tools drop that side table, so the survey is also
//! expressed in standard constructs:
//!
//! - `<Variables>`: one per metadata column and closed question (multi-select
//!   becomes one Boolean variable per option);
//! - `<Cases>`: one per respondent, with typed values and a `<SourceRef>` to
//!   that respondent's open-ended document;
//! - a per-respondent `<TextSource>` holding the open-ended answers, each
//!   prefixed with a `[[MQ:<questionId>]] <question>` sentinel so a coded
//!   span maps back to its cell on import.

use crate::util::{Obj, cp_len, get_arr, get_f64, get_str, js_num_to_string, new_guid, num};
use regex::Regex;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::sync::LazyLock;

const TAG: &str = "magnolia:v1:";
static SENTINEL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\[\[MQ:([^\]]+)\]\] ?(.*)$").unwrap());

pub struct SurveyRefi {
    pub variables: Vec<Value>,
    pub cases: Vec<Value>,
    pub respondent_docs: Vec<Value>,
}

/// Cleaning applied to a survey cell's raw value. MUST stay identical to
/// renderer/utils/survey/cell-text.ts `cleanCellText` — cell-relative offsets
/// index into exactly this output.
fn clean_cell_text(raw: &str) -> String {
    static TAGS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<[^>]+>").unwrap());
    static WS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\s\u{feff}]+").unwrap());
    let s = TAGS.replace_all(raw, " ");
    let s = s
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'");
    let s = WS.replace_all(&s, " ");
    crate::util::js_trim(&s).to_string()
}

fn build_cell_text(answer: Option<&Value>) -> String {
    match answer {
        Some(Value::Array(a)) => a
            .iter()
            .map(|v| clean_cell_text(v.as_str().unwrap_or("")))
            .collect::<Vec<_>>()
            .join("\n"),
        Some(Value::String(s)) => clean_cell_text(s),
        _ => clean_cell_text(""),
    }
}

fn answer_string(r: &Value, qid: &str) -> String {
    match r.get("answers").and_then(|a| a.get(qid)) {
        None | Some(Value::Null) => String::new(),
        Some(Value::Array(a)) => a
            .iter()
            .map(crate::util::js_to_string)
            .collect::<Vec<_>>()
            .join(", "),
        Some(v) => crate::util::js_to_string(v),
    }
}

fn parse_tag(desc: Option<&str>) -> Option<(String, Option<String>, Option<i64>)> {
    let rest = desc?.strip_prefix(TAG)?;
    if let Some(ms) = rest.strip_prefix("multi-select:") {
        let mut parts = ms.split(':');
        let qid = parts.next().map(str::to_string);
        let idx = crate::util::js_parse_int(parts.next())
            .filter(|n| *n != 0)
            .unwrap_or(0);
        return Some(("multi-select".into(), qid, Some(idx)));
    }
    ["metadata", "single-choice", "numeric"]
        .contains(&rest)
        .then(|| (rest.to_string(), None, None))
}

/// Build one respondent's open-ended document text plus, per question id,
/// the codepoint offset where that answer's body starts.
fn build_respondent_doc(r: &Value, open_ended: &[&Value]) -> (String, HashMap<String, usize>) {
    let mut text = String::new();
    let mut cp = 0;
    let mut answer_start = HashMap::new();
    for q in open_ended {
        let qid = get_str(q, "id").unwrap_or("");
        let header = format!("[[MQ:{qid}]] {}\n", get_str(q, "text").unwrap_or(""));
        cp += cp_len(&header);
        text.push_str(&header);
        answer_start.insert(qid.to_string(), cp);
        let body = build_cell_text(r.get("answers").and_then(|a| a.get(qid)));
        cp += cp_len(&body);
        text.push_str(&body);
        text.push_str("\n\n");
        cp += 2;
    }
    (text, answer_start)
}

pub fn survey_to_refi(survey: &Value, source_guid: &str, selections: &[Value]) -> SurveyRefi {
    let columns = get_arr(survey, "columns");
    let lookup_column = |id: &str| columns.iter().find(|c| get_str(c, "id") == Some(id));
    let mut variables = Vec::new();
    let mut meta_var_by_column: Vec<(String, String)> = Vec::new(); // (columnId, varGuid)
    let mut question_vars: Vec<(&Value, Vec<String>)> = Vec::new();

    for column_id in get_arr(survey, "metadataColumnIds")
        .iter()
        .filter_map(Value::as_str)
    {
        let Some(col) = lookup_column(column_id) else {
            continue;
        };
        let name = [get_str(col, "cleanHeader"), get_str(col, "rawHeader")]
            .into_iter()
            .flatten()
            .find(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| {
                format!(
                    "Field {}",
                    js_num_to_string(get_f64(col, "index").unwrap_or(f64::NAN) + 1.0)
                )
            });
        let guid = new_guid();
        variables.push(json!({ "guid": guid, "name": name, "typeOfVariable": "Text", "description": format!("{TAG}metadata") }));
        meta_var_by_column.push((column_id.to_string(), guid));
    }

    for q in get_arr(survey, "questions") {
        let qtype = get_str(q, "type").unwrap_or("");
        if qtype == "open-ended" {
            continue;
        }
        let qid = get_str(q, "id").unwrap_or("");
        let qtext = get_str(q, "text").unwrap_or("");
        if qtype == "multi-select" {
            let mut guids = Vec::new();
            for (i, c) in get_arr(q, "columns").iter().enumerate() {
                let g = new_guid();
                variables.push(json!({
                    "guid": g,
                    "name": format!("{qtext} — {}", get_str(c, "optionLabel").unwrap_or("")),
                    "typeOfVariable": "Boolean",
                    "description": format!("{TAG}multi-select:{qid}:{i}"),
                }));
                guids.push(g);
            }
            question_vars.push((q, guids));
        } else {
            let g = new_guid();
            let numeric = qtype == "numeric";
            variables.push(json!({
                "guid": g,
                "name": qtext,
                "typeOfVariable": if numeric { "Float" } else { "Text" },
                "description": format!("{TAG}{}", if numeric { "numeric" } else { "single-choice" }),
            }));
            question_vars.push((q, vec![g]));
        }
    }

    let open_ended: Vec<&Value> = get_arr(survey, "questions")
        .iter()
        .filter(|q| get_str(q, "type") == Some("open-ended"))
        .collect();

    let mut cell_sels_by_respondent: HashMap<String, Vec<&Value>> = HashMap::new();
    for sel in selections {
        let Some(cell) = sel.get("surveyCell").filter(|c| c.is_object()) else {
            continue;
        };
        let qid = get_str(cell, "questionId").unwrap_or("");
        if !open_ended.iter().any(|q| get_str(q, "id") == Some(qid)) {
            continue;
        }
        cell_sels_by_respondent
            .entry(get_str(cell, "respondentId").unwrap_or("").to_string())
            .or_default()
            .push(sel);
    }

    let mut respondent_docs = Vec::new();
    let mut cases = Vec::new();
    for r in get_arr(survey, "respondents") {
        let mut values = Vec::new();
        for (column_id, vguid) in &meta_var_by_column {
            let raw = r
                .get("metadata")
                .and_then(|m| m.get(column_id))
                .and_then(Value::as_str)
                .unwrap_or("");
            if !raw.is_empty() {
                values.push(json!({ "variableGuid": vguid, "textValue": raw }));
            }
        }
        for (q, vars) in &question_vars {
            let qid = get_str(q, "id").unwrap_or("");
            match get_str(q, "type").unwrap_or("") {
                "multi-select" => {
                    let selected: Vec<String> = match r.get("answers").and_then(|a| a.get(qid)) {
                        Some(Value::Array(a)) => a.iter().map(crate::util::js_to_string).collect(),
                        _ => vec![],
                    };
                    for (i, c) in get_arr(q, "columns").iter().enumerate() {
                        let label = get_str(c, "optionLabel").unwrap_or("");
                        values.push(json!({ "variableGuid": vars[i], "booleanValue": selected.iter().any(|s| s == label) }));
                    }
                }
                "numeric" => {
                    let raw = answer_string(r, qid);
                    let raw = crate::util::js_trim(&raw);
                    let cleaned = raw.replace(',', "");
                    let n: Option<f64> = if cleaned.trim().is_empty() {
                        Some(0.0)
                    } else {
                        cleaned.trim().parse().ok()
                    };
                    if let Some(n) = n.filter(|n| !raw.is_empty() && n.is_finite()) {
                        values.push(json!({ "variableGuid": vars[0], "floatValue": num(n) }));
                    }
                }
                _ => {
                    let raw = answer_string(r, qid);
                    if !raw.is_empty() {
                        values.push(json!({ "variableGuid": vars[0], "textValue": raw }));
                    }
                }
            }
        }

        let rid = get_str(r, "id").unwrap_or("");
        let mut source_ref_guids = Vec::new();
        if !open_ended.is_empty() {
            let (text, answer_start) = build_respondent_doc(r, &open_ended);
            let doc_guid = new_guid();
            let mut doc_sels = Vec::new();
            for sel in cell_sels_by_respondent
                .get(rid)
                .map(|v| v.as_slice())
                .unwrap_or(&[])
            {
                let qid = sel
                    .get("surveyCell")
                    .and_then(|c| get_str(c, "questionId"))
                    .unwrap_or("");
                let Some(&base) = answer_start.get(qid) else {
                    continue;
                };
                // Fresh guids on the selection AND its codings: the same cell
                // selection also lives cell-relative in the side table, and a
                // duplicate guid makes Atlas.ti reject the file.
                let codings: Vec<Value> = get_arr(sel, "codings")
                    .iter()
                    .map(|cd| {
                        let mut c = cd.clone();
                        c["guid"] = new_guid().into();
                        c
                    })
                    .collect();
                doc_sels.push(json!({
                    "guid": new_guid(),
                    "startPosition": num(base as f64 + get_f64(sel, "startPosition").unwrap_or(0.0)),
                    "endPosition": num(base as f64 + get_f64(sel, "endPosition").unwrap_or(0.0)),
                    "codings": codings,
                }));
            }
            respondent_docs.push(json!({
                "guid": doc_guid,
                "name": format!("{} — responses", get_str(r, "displayName").unwrap_or("")),
                "text": text,
                "selections": doc_sels,
                "sourceGuid": source_guid,
                "respondentId": rid,
            }));
            source_ref_guids.push(doc_guid);
        }
        cases.push(json!({
            "guid": new_guid(),
            "name": get_str(r, "displayName").unwrap_or(""),
            "sourceRefGuids": source_ref_guids,
            "values": values,
        }));
    }

    SurveyRefi {
        variables,
        cases,
        respondent_docs,
    }
}

fn infer_type(v: &Value) -> &'static str {
    match get_str(v, "typeOfVariable") {
        Some("Boolean") => "single-choice",
        Some("Float") | Some("Integer") => "numeric",
        _ => "open-ended",
    }
}

fn value_to_string(val: &Value) -> String {
    if let Some(t) = val.get("textValue").filter(|v| !v.is_null()) {
        return crate::util::js_to_string(t);
    }
    if let Some(b) = val.get("booleanValue").and_then(Value::as_bool) {
        return if b { "true" } else { "false" }.into();
    }
    for k in ["integerValue", "floatValue"] {
        if let Some(n) = val.get(k).filter(|v| !v.is_null()) {
            return crate::util::js_to_string(n);
        }
    }
    String::new()
}

/// Split a respondent doc into per-question `(body, bodyStartCp)` using the
/// `[[MQ:id]]` sentinels. Insertion-ordered by first appearance.
fn parse_respondent_doc(text: &str) -> Vec<(String, String, usize)> {
    let mut out: Vec<(String, String, usize)> = Vec::new();
    if text.is_empty() {
        return out;
    }
    let mut cp = 0;
    let mut current: Option<(String, usize, Vec<&str>)> = None;
    let flush = |cur: &Option<(String, usize, Vec<&str>)>,
                 out: &mut Vec<(String, String, usize)>| {
        if let Some((qid, start, lines)) = cur {
            let body = lines.join("\n").trim_end_matches('\n').to_string();
            match out.iter_mut().find(|e| &e.0 == qid) {
                Some(e) => {
                    e.1 = body;
                    e.2 = *start;
                }
                None => out.push((qid.clone(), body, *start)),
            }
        }
    };
    for line in text.split('\n') {
        if let Some(m) = SENTINEL_RE.captures(line) {
            flush(&current, &mut out);
            current = Some((m[1].to_string(), cp + cp_len(line) + 1, Vec::new()));
        } else if let Some(c) = current.as_mut() {
            c.2.push(line);
        }
        cp += cp_len(line) + 1;
    }
    flush(&current, &mut out);
    out
}

pub struct RefiSurvey {
    pub survey: Value,
    pub cell_selections: Vec<Value>,
    pub doc_to_respondent: Vec<(String, String)>,
}

/// Reconstruct a best-effort SurveyData (plus cell selections) from REFI
/// Variables + Cases + respondent documents, for surveys that arrived without
/// Magnolia's side table. `docs` maps doc guid → (text, selections), in
/// source order.
pub fn refi_to_survey(
    variables: &[Value],
    cases: &[Value],
    docs: &[(String, String, Vec<Value>)],
    survey_name: &str,
) -> RefiSurvey {
    let mut referenced = std::collections::HashSet::new();
    for c in cases {
        for v in get_arr(c, "values") {
            if let Some(g) = get_str(v, "variableGuid") {
                referenced.insert(g.to_string());
            }
        }
    }
    let ours: Vec<&Value> = variables
        .iter()
        .filter(|v| get_str(v, "guid").is_some_and(|g| referenced.contains(g)))
        .collect();

    let mut columns: Vec<Value> = Vec::new();
    let mut questions: Vec<Value> = Vec::new();
    let mut metadata_column_ids: Vec<String> = Vec::new();
    let mut column_id_by_var: Vec<(String, String)> = Vec::new();
    let mut multi_groups: HashMap<String, usize> = HashMap::new();
    let mut index = 0i64;

    let col_for_var = |m: &Vec<(String, String)>, vg: &str| {
        m.iter().find(|(v, _)| v == vg).map(|(_, c)| c.clone())
    };
    let var_for_col = |m: &Vec<(String, String)>, cid: &str| {
        m.iter().find(|(_, c)| c == cid).map(|(v, _)| v.clone())
    };

    for v in &ours {
        let vguid = get_str(v, "guid").unwrap_or("").to_string();
        let vname = get_str(v, "name").unwrap_or("").to_string();
        let tag = parse_tag(get_str(v, "description"));
        let vtype = tag
            .as_ref()
            .map(|t| t.0.clone())
            .unwrap_or_else(|| infer_type(v).to_string());

        if vtype == "multi-select"
            && let Some(qid_old) = tag.as_ref().and_then(|t| t.1.clone())
        {
            let column_id = new_guid();
            column_id_by_var.push((vguid.clone(), column_id.clone()));
            let (question_text, option_label) = match vname.find(" — ") {
                Some(i) => (vname[..i].to_string(), vname[i + " — ".len()..].to_string()),
                None => (vname.clone(), vname.clone()),
            };
            columns.push(json!({
                "id": column_id, "index": index, "rawHeader": question_text, "rawSubhead": option_label,
                "cleanHeader": question_text, "cleanSubhead": option_label, "type": "multi-select",
            }));
            index += 1;
            let qi = *multi_groups.entry(qid_old).or_insert_with(|| {
                questions.push(json!({ "id": new_guid(), "text": question_text, "rawText": question_text, "type": "multi-select", "columns": [] }));
                questions.len() - 1
            });
            let cols = questions[qi]["columns"].as_array_mut().unwrap();
            cols.push(json!({ "columnId": column_id, "optionLabel": option_label }));
            let option_index = |cid: &str| -> i64 {
                ours.iter()
                    .find(|x| {
                        col_for_var(&column_id_by_var, get_str(x, "guid").unwrap_or("")).as_deref()
                            == Some(cid)
                    })
                    .and_then(|x| parse_tag(get_str(x, "description")))
                    .and_then(|t| t.2)
                    .unwrap_or(0)
            };
            cols.sort_by_key(|c| option_index(get_str(c, "columnId").unwrap_or("")));
            continue;
        }

        let column_id = new_guid();
        column_id_by_var.push((vguid, column_id.clone()));
        let sub = if vtype == "metadata" { "" } else { "Response" };
        columns.push(json!({
            "id": column_id, "index": index, "rawHeader": vname, "rawSubhead": sub,
            "cleanHeader": vname, "cleanSubhead": sub, "type": vtype,
        }));
        index += 1;
        if vtype == "metadata" {
            metadata_column_ids.push(column_id);
        } else {
            questions.push(json!({
                "id": new_guid(), "text": vname, "rawText": vname, "type": vtype,
                "columns": [{ "columnId": column_id, "optionLabel": "Response" }],
            }));
        }
    }

    // Open-ended questions from the document sentinels.
    let mut open_by_old_id: HashMap<String, String> = HashMap::new(); // old id → question id
    let mut parsed_docs: HashMap<String, Vec<(String, String, usize)>> = HashMap::new();
    for (guid, text, _) in docs {
        let segs = parse_respondent_doc(text);
        for (old_id, _, _) in &segs {
            if open_by_old_id.contains_key(old_id) {
                continue;
            }
            let header_text = text
                .split('\n')
                .filter_map(|l| SENTINEL_RE.captures(l))
                .find(|m| &m[1] == old_id.as_str())
                .map(|m| crate::util::js_trim(&m[2]).to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "Open-ended response".into());
            let column_id = new_guid();
            let qid = new_guid();
            questions.push(json!({
                "id": qid, "text": header_text, "rawText": header_text, "type": "open-ended",
                "columns": [{ "columnId": column_id, "optionLabel": "Open-Ended Response" }],
            }));
            columns.push(json!({
                "id": column_id, "index": index, "rawHeader": header_text, "rawSubhead": "Open-Ended Response",
                "cleanHeader": header_text, "cleanSubhead": "Open-Ended Response", "type": "open-ended",
            }));
            index += 1;
            open_by_old_id.insert(old_id.clone(), qid);
        }
        parsed_docs.insert(guid.clone(), segs);
    }

    let mut cell_selections = Vec::new();
    let mut doc_to_respondent = Vec::new();
    let mut respondents = Vec::new();
    for (ci, c) in cases.iter().enumerate() {
        let value_by_var: HashMap<&str, &Value> = get_arr(c, "values")
            .iter()
            .filter_map(|v| get_str(v, "variableGuid").map(|g| (g, v)))
            .collect();
        let respondent_id = new_guid();

        let mut metadata = Map::new();
        for v in &ours {
            let Some(cid) = col_for_var(&column_id_by_var, get_str(v, "guid").unwrap_or("")) else {
                continue;
            };
            if !metadata_column_ids.contains(&cid) {
                continue;
            }
            let val = value_by_var
                .get(get_str(v, "guid").unwrap_or(""))
                .map(|v| value_to_string(v))
                .unwrap_or_default();
            metadata.insert(cid, val.into());
        }

        let mut answers = Map::new();
        for q in &questions {
            let qtype = get_str(q, "type").unwrap_or("");
            let qid = get_str(q, "id").unwrap_or("").to_string();
            if qtype == "open-ended" {
                continue;
            }
            if qtype == "multi-select" {
                let mut selected = Vec::new();
                for c2 in get_arr(q, "columns") {
                    let Some(vg) =
                        var_for_col(&column_id_by_var, get_str(c2, "columnId").unwrap_or(""))
                    else {
                        continue;
                    };
                    if value_by_var
                        .get(vg.as_str())
                        .and_then(|v| v.get("booleanValue"))
                        .and_then(Value::as_bool)
                        == Some(true)
                    {
                        selected.push(c2.get("optionLabel").cloned().unwrap_or(Value::Null));
                    }
                }
                answers.insert(qid, selected.into());
            } else {
                let first_col = get_arr(q, "columns")
                    .first()
                    .and_then(|c| get_str(c, "columnId"))
                    .unwrap_or("");
                let val = var_for_col(&column_id_by_var, first_col)
                    .and_then(|vg| value_by_var.get(vg.as_str()).map(|v| value_to_string(v)))
                    .unwrap_or_default();
                answers.insert(qid, val.into());
            }
        }

        let source_refs = get_arr(c, "sourceRefGuids");
        let doc = source_refs
            .iter()
            .filter_map(Value::as_str)
            .find_map(|g| docs.iter().find(|(dg, _, _)| dg == g));
        if let Some((doc_guid, _, doc_sels)) = doc {
            doc_to_respondent.push((doc_guid.clone(), respondent_id.clone()));
            for (old_id, body, body_start) in &parsed_docs[doc_guid] {
                let Some(qid) = open_by_old_id.get(old_id) else {
                    continue;
                };
                answers.insert(qid.clone(), body.clone().into());
                let body_end = (body_start + cp_len(body)) as f64;
                let body_start = *body_start as f64;
                for d in doc_sels {
                    let sp = get_f64(d, "startPosition").unwrap_or(0.0);
                    let ep = get_f64(d, "endPosition").unwrap_or(0.0);
                    if sp < body_start || sp >= body_end {
                        continue;
                    }
                    cell_selections.push(json!({
                        "guid": new_guid(),
                        "startPosition": num(sp - body_start),
                        "endPosition": num(ep.min(body_end) - body_start),
                        "codings": d.get("codings").cloned().unwrap_or(json!([])),
                        "surveyCell": { "respondentId": respondent_id, "questionId": qid },
                    }));
                }
            }
        }

        let name = get_str(c, "name")
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("Respondent {}", ci + 1));
        let mut r = Obj::new();
        r.insert("id".into(), respondent_id.into());
        r.insert("displayName".into(), name.into());
        r.insert("metadata".into(), Value::Object(metadata));
        r.insert("answers".into(), Value::Object(answers));
        respondents.push(Value::Object(r));
    }

    RefiSurvey {
        survey: json!({
            "name": survey_name, "columns": columns, "questions": questions,
            "metadataColumnIds": metadata_column_ids, "respondents": respondents,
        }),
        cell_selections,
        doc_to_respondent,
    }
}
