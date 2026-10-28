//! Shared HTML helpers for the converters.

pub fn escape(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            '\'' => o.push_str("&#39;"),
            _ => o.push(c),
        }
    }
    o
}

pub fn escape_attr(s: &str) -> String {
    s.replace('"', "&quot;")
}

pub fn data_uri(mime: &str, bytes: &[u8]) -> String {
    use base64::Engine;
    format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

pub fn image_mime(ext: &str) -> &'static str {
    match ext.to_lowercase().as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "webp" => "image/webp",
        _ => "image/png",
    }
}

/// Wrap converted body HTML in a full document with print-safe styling that
/// keeps the source's fonts / colours / borders and readable tables.
pub fn print_document(body: &str) -> String {
    format!(
        r#"<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  @page {{ margin: 0.4in; }}
  body {{
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    font-size: 12pt;
    line-height: 1.5;
    color: #000;
    max-width: 100%;
    padding: 0;
    margin: 0;
  }}
  img {{ max-width: 100%; height: auto; }}
  table {{ border-collapse: collapse; width: 100%; margin: 8px 0; }}
  td, th {{ border: 1px solid #ccc; padding: 4px 8px; vertical-align: top; }}
  p {{ margin: 0 0 8px; }}
</style>
</head>
<body>{body}</body>
</html>"#
    )
}
