//! Minimal XML writer reproducing the exact layout the TypeScript build got
//! from fast-xml-parser's `XMLBuilder` (`format: true`, two-space indent,
//! `suppressEmptyNode`), so files written by either build diff cleanly.
//!
//! Escaping is ours, as it was in TS: attributes escape `& < > " '`, text
//! escapes `& < >`.

#[derive(Debug, Clone, Default)]
pub struct El {
    pub name: String,
    pub attrs: Vec<(String, String)>,
    pub children: Vec<El>,
    pub text: Option<String>,
}

impl El {
    pub fn new(name: &str) -> Self {
        El {
            name: name.to_string(),
            ..Default::default()
        }
    }

    /// Element holding only text (`<Description>…</Description>`).
    pub fn text(name: &str, text: impl Into<String>) -> Self {
        El {
            name: name.to_string(),
            text: Some(text.into()),
            ..Default::default()
        }
    }

    pub fn attr(mut self, key: &str, value: impl Into<String>) -> Self {
        self.attrs.push((key.to_string(), value.into()));
        self
    }

    pub fn set(&mut self, key: &str, value: impl Into<String>) {
        self.attrs.push((key.to_string(), value.into()));
    }

    pub fn set_opt(&mut self, key: &str, value: Option<impl Into<String>>) {
        if let Some(v) = value {
            self.set(key, v);
        }
    }

    pub fn child(mut self, el: El) -> Self {
        self.children.push(el);
        self
    }

    pub fn push(&mut self, el: El) {
        self.children.push(el);
    }

    fn write(&self, out: &mut String, depth: usize) {
        let indent = "  ".repeat(depth);
        out.push_str(&indent);
        out.push('<');
        out.push_str(&self.name);
        for (k, v) in &self.attrs {
            out.push(' ');
            out.push_str(k);
            out.push_str("=\"");
            out.push_str(&escape_attr(v));
            out.push('"');
        }
        let text = self.text.as_deref().unwrap_or("");
        if self.children.is_empty() && text.is_empty() {
            out.push_str("/>\n");
            return;
        }
        out.push('>');
        if self.children.is_empty() {
            out.push_str(&escape_text(text));
            out.push_str("</");
            out.push_str(&self.name);
            out.push_str(">\n");
            return;
        }
        out.push('\n');
        for c in &self.children {
            c.write(out, depth + 1);
        }
        out.push_str(&indent);
        out.push_str("</");
        out.push_str(&self.name);
        out.push_str(">\n");
    }
}

/// Serialize a document: the `<?xml …?>` declaration line, then the root.
pub fn document(decl_attrs: &[(&str, &str)], root: &El) -> String {
    let mut out = String::from("<?xml");
    for (k, v) in decl_attrs {
        out.push_str(&format!(" {k}=\"{}\"", escape_attr(v)));
    }
    out.push_str("?>\n");
    root.write(&mut out, 0);
    out
}

pub fn escape_attr(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            '\'' => o.push_str("&apos;"),
            _ => o.push(c),
        }
    }
    o
}

pub fn escape_text(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            _ => o.push(c),
        }
    }
    o
}

/// Upper-case every GUID inside guid-bearing attributes. Magnolia keeps
/// GUIDs uppercase already, so this is defence-in-depth: the QDA-XML schema's
/// GUIDType pattern is uppercase hex and Atlas.ti / MAXQDA reject lowercase.
pub fn uppercase_guids(xml: &str, attr_names: &str) -> String {
    use regex::Regex;
    let attr_re = Regex::new(&format!(r#"\b({attr_names})="([^"]+)""#)).unwrap();
    let guid_re = Regex::new(
        r"\b([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\b",
    )
    .unwrap();
    attr_re
        .replace_all(xml, |caps: &regex::Captures| {
            let upped = guid_re.replace_all(&caps[2], |g: &regex::Captures| g[1].to_uppercase());
            format!("{}=\"{}\"", &caps[1], upped)
        })
        .into_owned()
}
