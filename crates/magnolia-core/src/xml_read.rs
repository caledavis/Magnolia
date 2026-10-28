//! Read-side XML helpers over `roxmltree`, giving the deserializers the same
//! view of a document the TypeScript build had through fast-xml-parser:
//! elements addressed by local name, attribute and text values trimmed.
//!
//! One deliberate difference: numeric character references (`&#233;`) are
//! decoded. fast-xml-parser left them as literal text, which garbled names
//! and transcript text written by tools that use them.

use crate::util::js_trim;
use roxmltree::Node;

/// Prepare document text for [`parse`] so it reads the way fast-xml-parser
/// read it in the TypeScript build:
///
/// - Value-less boolean attributes (`<Code … isCodable color="…"/>`), which
///   older Magnolia builds wrote, become `name="true"` instead of failing.
/// - Literal newlines / tabs inside attribute values are kept. A conforming
///   parser normalises them to spaces, but Magnolia writes selection names
///   with raw newlines and must read them back unchanged, so they're turned
///   into character references (which normalisation leaves alone).
///
/// Returns the input borrowed when nothing needed changing.
pub fn repair_if_needed(xml: &str) -> std::borrow::Cow<'_, str> {
    match prepare(xml) {
        Some(s) => std::borrow::Cow::Owned(s),
        None => std::borrow::Cow::Borrowed(xml),
    }
}

pub fn parse(xml: &str) -> Result<roxmltree::Document<'_>, roxmltree::Error> {
    roxmltree::Document::parse_with_options(
        xml,
        roxmltree::ParsingOptions {
            allow_dtd: true,
            ..Default::default()
        },
    )
}

/// The rewrite behind [`repair_if_needed`]; `None` when the text is unchanged.
fn prepare(xml: &str) -> Option<String> {
    let b = xml.as_bytes();
    let mut out = String::new();
    let mut changed = false;
    let mut i = 0;
    let mut last = 0;
    let skip_to = |from: usize, end: &str| {
        xml[from..]
            .find(end)
            .map(|p| from + p + end.len())
            .unwrap_or(b.len())
    };
    while i < b.len() {
        if b[i] != b'<' {
            i += 1;
            continue;
        }
        let rest = &xml[i..];
        if rest.starts_with("<!--") {
            i = skip_to(i, "-->");
            continue;
        }
        if rest.starts_with("<![CDATA[") {
            i = skip_to(i, "]]>");
            continue;
        }
        if matches!(b.get(i + 1), Some(b'!' | b'?' | b'/')) {
            i += 1;
            continue;
        }
        // Skip the tag name.
        i += 1;
        while i < b.len() && !b[i].is_ascii_whitespace() && b[i] != b'>' && b[i] != b'/' {
            i += 1;
        }
        loop {
            while i < b.len() && b[i].is_ascii_whitespace() {
                i += 1;
            }
            if i >= b.len() || b[i] == b'>' || b[i] == b'/' {
                break;
            }
            let name_start = i;
            while i < b.len() && !b[i].is_ascii_whitespace() && !matches!(b[i], b'=' | b'>' | b'/')
            {
                i += 1;
            }
            let name_end = i;
            let mut j = i;
            while j < b.len() && b[j].is_ascii_whitespace() {
                j += 1;
            }
            if j < b.len() && b[j] == b'=' {
                j += 1;
                while j < b.len() && b[j].is_ascii_whitespace() {
                    j += 1;
                }
                if j < b.len() && (b[j] == b'"' || b[j] == b'\'') {
                    let q = b[j];
                    j += 1;
                    while j < b.len() && b[j] != q {
                        let r = match b[j] {
                            b'\n' => Some("&#10;"),
                            b'\r' => Some("&#13;"),
                            b'\t' => Some("&#9;"),
                            _ => None,
                        };
                        if let Some(r) = r {
                            out.push_str(&xml[last..j]);
                            out.push_str(r);
                            last = j + 1;
                            changed = true;
                        }
                        j += 1;
                    }
                    j += 1;
                }
                i = j;
            } else if name_end > name_start {
                out.push_str(&xml[last..name_end]);
                out.push_str("=\"true\"");
                last = name_end;
                changed = true;
            }
        }
    }
    if !changed {
        return None;
    }
    out.push_str(&xml[last..]);
    Some(out)
}

pub fn attr(n: Node, name: &str) -> Option<String> {
    n.attributes()
        .find(|a| a.name() == name)
        .map(|a| js_trim(a.value()).to_string())
}

/// Element children with the given local name.
pub fn children<'a, 'input>(
    n: Node<'a, 'input>,
    name: &'a str,
) -> impl Iterator<Item = Node<'a, 'input>> + 'a {
    n.children()
        .filter(move |c| c.is_element() && c.tag_name().name() == name)
}

pub fn child<'a, 'input>(n: Node<'a, 'input>, name: &str) -> Option<Node<'a, 'input>> {
    n.children()
        .find(|c| c.is_element() && c.tag_name().name() == name)
}

/// Follow a path of child element names (`proj.Sources?.TextSource` style).
pub fn path<'a, 'input>(n: Node<'a, 'input>, names: &[&str]) -> Option<Node<'a, 'input>> {
    let mut cur = n;
    for name in names {
        cur = child(cur, name)?;
    }
    Some(cur)
}

/// Every element at `names[..-1]` then the repeated child `names[-1]`.
pub fn list<'a, 'input>(n: Node<'a, 'input>, names: &[&'a str]) -> Vec<Node<'a, 'input>> {
    let (last, parents) = names.split_last().unwrap();
    match path(n, parents) {
        Some(p) => children(p, last).collect(),
        None => Vec::new(),
    }
}

/// Trimmed text content of an element (CDATA kept verbatim, as
/// fast-xml-parser did). `None` when the element is absent.
pub fn text_of(n: Node) -> String {
    let mut out = String::new();
    let mut cdata = false;
    for c in n.children() {
        if c.is_text() {
            out.push_str(c.text().unwrap_or(""));
        }
        // roxmltree folds CDATA into text nodes; detect it from the source
        // so the CDATA body isn't trimmed.
        if c.is_text() && n.document().input_text()[c.range()].starts_with("<![CDATA[") {
            cdata = true;
        }
    }
    if cdata {
        out
    } else {
        js_trim(&out).to_string()
    }
}

pub fn child_text(n: Node, name: &str) -> Option<String> {
    child(n, name).map(text_of)
}
