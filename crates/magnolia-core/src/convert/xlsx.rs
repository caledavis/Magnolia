//! XLSX → CSV for the survey importer, which expects CSV text.
//!
//! Reads the first worksheet. Cell text approximates spreadsheet display
//! formatting: numbers in General format, dates as `M/D/YY[ H:MM]`, booleans
//! as `TRUE`/`FALSE`. The CSV is quoted only where needed.

use calamine::{Data, Reader, open_workbook_auto_from_rs};
use std::io::Cursor;

pub fn xlsx_to_csv(bytes: &[u8]) -> Result<String, String> {
    let mut wb = open_workbook_auto_from_rs(Cursor::new(bytes.to_vec()))
        .map_err(|e| format!("Could not read spreadsheet: {e}"))?;
    let first = wb
        .sheet_names()
        .first()
        .cloned()
        .ok_or("XLSX file has no worksheets.")?;
    let range = wb
        .worksheet_range(&first)
        .map_err(|e| format!("Could not read worksheet: {e}"))?;
    let Some((end_r, end_c)) = range.end() else {
        return Ok(String::new());
    };
    let mut lines = Vec::with_capacity(end_r as usize + 1);
    // Cover A1 to the last used cell, as the sheet's own dimension would.
    for r in 0..=end_r {
        let mut fields = Vec::with_capacity(end_c as usize + 1);
        for c in 0..=end_c {
            let text = range.get_value((r, c)).map(cell_text).unwrap_or_default();
            fields.push(quote(&text));
        }
        lines.push(fields.join(","));
    }
    Ok(lines.join("\n"))
}

fn quote(s: &str) -> String {
    if s.contains(['"', ',', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

fn cell_text(d: &Data) -> String {
    match d {
        Data::Empty => String::new(),
        Data::String(s) | Data::DateTimeIso(s) | Data::DurationIso(s) => s.clone(),
        Data::Int(i) => i.to_string(),
        Data::Float(f) => general_number(*f),
        Data::Bool(b) => if *b { "TRUE" } else { "FALSE" }.into(),
        Data::Error(e) => format!("{e}"),
        Data::DateTime(dt) => excel_date(dt.as_f64()),
    }
}

/// Excel's General format: up to 11 significant digits, trailing zeros dropped.
fn general_number(f: f64) -> String {
    if f.fract() == 0.0 && f.abs() < 1e15 {
        return format!("{}", f as i64);
    }
    let digits = 10 - (f.abs().log10().floor() as i32).max(0);
    let s = format!("{:.*}", digits.clamp(0, 10) as usize, f);
    let s = s.trim_end_matches('0').trim_end_matches('.');
    s.to_string()
}

/// Excel serial date (1900 system) → `M/D/YY` or `M/D/YY H:MM`.
fn excel_date(serial: f64) -> String {
    let days = serial.floor() as i64;
    let secs = ((serial - serial.floor()) * 86400.0).round() as i64;
    let base = chrono::NaiveDate::from_ymd_opt(1899, 12, 30).unwrap();
    let date = base + chrono::Duration::days(days);
    use chrono::Datelike;
    let d = format!("{}/{}/{:02}", date.month(), date.day(), date.year() % 100);
    if serial < 1.0 {
        return format!("{}:{:02}", secs / 3600, (secs % 3600) / 60);
    }
    if secs == 0 {
        d
    } else {
        format!("{d} {}:{:02}", secs / 3600, (secs % 3600) / 60)
    }
}
