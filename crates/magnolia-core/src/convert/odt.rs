//! ODT → HTML.
//!
//! Walks `content.xml`, resolving paragraph/text styles (with inheritance)
//! from both `styles.xml` and the document's automatic styles, and inlines
//! pictures from `Pictures/` as data URIs. Preserves paragraph text,
//! headings, bold / italic / underline, font family / size / colour,
//! background colour, lists and tables; anything else degrades to its text.

use super::html::{data_uri, escape, escape_attr, image_mime};
use roxmltree::Node;
use std::collections::HashMap;
use std::io::{Cursor, Read};

const NS: &[(&str, &str)] = &[
    ("urn:oasis:names:tc:opendocument:xmlns:office:1.0", "office"),
    ("urn:oasis:names:tc:opendocument:xmlns:style:1.0", "style"),
    ("urn:oasis:names:tc:opendocument:xmlns:text:1.0", "text"),
    ("urn:oasis:names:tc:opendocument:xmlns:table:1.0", "table"),
    ("urn:oasis:names:tc:opendocument:xmlns:drawing:1.0", "draw"),
    (
        "urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0",
        "fo",
    ),
    ("http://www.w3.org/1999/xlink", "xlink"),
];

fn prefix(uri: Option<&str>) -> &'static str {
    uri.and_then(|u| NS.iter().find(|(n, _)| *n == u).map(|(_, p)| *p))
        .unwrap_or("")
}

fn qname(n: Node) -> String {
    format!(
        "{}:{}",
        prefix(n.tag_name().namespace()),
        n.tag_name().name()
    )
}

fn attr<'a>(n: Node<'a, '_>, q: &str) -> Option<&'a str> {
    let (p, local) = q.split_once(':')?;
    n.attributes()
        .find(|a| a.name() == local && prefix(a.namespace()) == p)
        .map(|a| a.value())
}

#[derive(Default, Clone)]
struct StyleDef {
    css: String,
    parent: Option<String>,
    text_css: String,
}

fn merge_css(a: &str, b: &str) -> String {
    match (a.is_empty(), b.is_empty()) {
        (true, _) => b.to_string(),
        (_, true) => a.to_string(),
        _ => format!("{a};{b}"),
    }
}

/// Map OpenDocument style attributes to CSS declarations.
fn odt_attrs_to_css(n: Node) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut take = |q: &str, f: &dyn Fn(&str) -> String| {
        if let Some(v) = attr(n, q).filter(|v| !v.is_empty()) {
            let css = f(v);
            if !css.is_empty() {
                out.push(css);
            }
        }
    };
    take("fo:color", &|v| format!("color:{v}"));
    take("fo:background-color", &|v| {
        if v != "transparent" {
            format!("background-color:{v}")
        } else {
            String::new()
        }
    });
    take("fo:font-weight", &|v| format!("font-weight:{v}"));
    take("fo:font-style", &|v| format!("font-style:{v}"));
    take("fo:font-size", &|v| format!("font-size:{v}"));
    take("fo:font-family", &|v| {
        format!("font-family:{}", v.replace(['"', '\''], ""))
    });
    take("style:font-name", &|v| {
        format!("font-family:{}", v.replace(['"', '\''], ""))
    });
    take("fo:text-align", &|v| format!("text-align:{v}"));
    take("style:text-underline-style", &|v| {
        if v != "none" {
            "text-decoration:underline".into()
        } else {
            String::new()
        }
    });
    take("style:text-line-through-style", &|v| {
        if v != "none" {
            "text-decoration:line-through".into()
        } else {
            String::new()
        }
    });
    for side in ["left", "right", "top", "bottom"] {
        let q = format!("fo:margin-{side}");
        take(&q, &|v| format!("margin-{side}:{v}"));
    }
    out.join(";")
}

fn collect_styles(root: Node, table: &mut HashMap<String, StyleDef>) {
    for n in root
        .descendants()
        .filter(|n| n.is_element() && qname(*n) == "style:style")
    {
        let Some(name) = attr(n, "style:name") else {
            continue;
        };
        let mut def = StyleDef {
            parent: attr(n, "style:parent-style-name").map(str::to_string),
            ..Default::default()
        };
        for c in n.children().filter(Node::is_element) {
            match qname(c).as_str() {
                "style:paragraph-properties" | "style:table-cell-properties" => {
                    def.css = merge_css(&def.css, &odt_attrs_to_css(c))
                }
                "style:text-properties" => {
                    let t = odt_attrs_to_css(c);
                    def.text_css = merge_css(&def.text_css, &t);
                    // Roll text rules into the block too so bare text picks them up.
                    def.css = merge_css(&def.css, &t);
                }
                _ => {}
            }
        }
        table.insert(name.to_string(), def);
    }
}

struct Ctx {
    styles: HashMap<String, StyleDef>,
    resolved: HashMap<String, (String, String)>,
    pictures: HashMap<String, String>,
}

impl Ctx {
    fn resolve(&mut self, name: &str, depth: usize) -> (String, String) {
        if let Some(r) = self.resolved.get(name) {
            return r.clone();
        }
        let Some(def) = self.styles.get(name).cloned() else {
            return Default::default();
        };
        if depth > 32 {
            return Default::default();
        }
        let parent = def
            .parent
            .as_deref()
            .map(|p| self.resolve(p, depth + 1))
            .unwrap_or_default();
        let merged = (
            merge_css(&parent.0, &def.css),
            merge_css(&parent.1, &def.text_css),
        );
        self.resolved.insert(name.to_string(), merged.clone());
        merged
    }
}

fn render_children(n: Node, ctx: &mut Ctx) -> String {
    n.children().map(|c| render(c, ctx)).collect()
}

fn style_attr(css: &str) -> String {
    if css.is_empty() {
        String::new()
    } else {
        format!(" style=\"{css}\"")
    }
}

fn render(n: Node, ctx: &mut Ctx) -> String {
    if n.is_text() {
        return escape(n.text().unwrap_or(""));
    }
    if !n.is_element() {
        return String::new();
    }
    let style_name = attr(n, "text:style-name").or_else(|| attr(n, "table:style-name"));
    let (css, text_css) = style_name.map(|s| ctx.resolve(s, 0)).unwrap_or_default();
    let or_nbsp = |s: String| {
        if s.is_empty() {
            "&nbsp;".to_string()
        } else {
            s
        }
    };
    match qname(n).as_str() {
        "text:p" => format!(
            "<p{}>{}</p>",
            style_attr(&css),
            or_nbsp(render_children(n, ctx))
        ),
        "text:h" => {
            let level = attr(n, "text:outline-level")
                .and_then(|l| l.parse::<i64>().ok())
                .unwrap_or(1)
                .clamp(1, 6);
            format!(
                "<h{level}{}>{}</h{level}>",
                style_attr(&css),
                or_nbsp(render_children(n, ctx))
            )
        }
        "text:span" => {
            let c = if text_css.is_empty() { &css } else { &text_css };
            format!("<span{}>{}</span>", style_attr(c), render_children(n, ctx))
        }
        "text:a" => format!(
            "<a href=\"{}\">{}</a>",
            escape_attr(attr(n, "xlink:href").unwrap_or("#")),
            render_children(n, ctx)
        ),
        "text:line-break" => "<br>".into(),
        "text:tab" => "&nbsp;&nbsp;&nbsp;&nbsp;".into(),
        "text:s" => "&nbsp;".repeat(
            attr(n, "text:c")
                .and_then(|c| c.parse().ok())
                .filter(|c: &usize| *c > 0)
                .unwrap_or(1),
        ),
        "text:list" => format!("<ul>{}</ul>", render_children(n, ctx)),
        "text:list-item" => format!("<li>{}</li>", render_children(n, ctx)),
        "table:table" => format!("<table>{}</table>", render_children(n, ctx)),
        "table:table-row" => format!("<tr>{}</tr>", render_children(n, ctx)),
        "table:table-cell" => format!(
            "<td{}>{}</td>",
            style_attr(&css),
            or_nbsp(render_children(n, ctx))
        ),
        "table:table-header-rows" => format!("<thead>{}</thead>", render_children(n, ctx)),
        "draw:image" => {
            let Some(href) = attr(n, "xlink:href") else {
                return String::new();
            };
            let src = ctx
                .pictures
                .get(href)
                .or_else(|| ctx.pictures.get(href.trim_start_matches("Pictures/")))
                .cloned()
                .unwrap_or_else(|| href.to_string());
            format!("<img src=\"{}\" />", escape_attr(&src))
        }
        "office:annotation" | "office:annotation-end" => String::new(),
        // Frames and unknown elements: recurse so nested text survives.
        _ => render_children(n, ctx),
    }
}

pub fn odt_to_html(bytes: &[u8]) -> Result<String, String> {
    let mut zip =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("Invalid ODT: {e}"))?;
    let mut read = |name: &str| -> Option<Vec<u8>> {
        let mut f = zip.by_name(name).ok()?;
        let mut b = Vec::new();
        f.read_to_end(&mut b).ok()?;
        Some(b)
    };
    let content = read("content.xml").ok_or("Invalid ODT: no content.xml")?;
    let styles = read("styles.xml");

    let mut pictures = HashMap::new();
    let names: Vec<String> = (0..zip.len())
        .filter_map(|i| {
            zip.name_for_index(i)
                .and_then(Result::ok)
                .map(|n| n.into_owned())
        })
        .collect();
    for name in names
        .iter()
        .filter(|n| n.starts_with("Pictures/") && !n.ends_with('/'))
    {
        let mut f = zip.by_name(name).map_err(|e| e.to_string())?;
        let mut b = Vec::new();
        f.read_to_end(&mut b).map_err(|e| e.to_string())?;
        let ext = crate::util::ext_of(name);
        let mime = if ext == "svg" {
            "image/svg+xml"
        } else {
            image_mime(&ext)
        };
        pictures.insert(name.clone(), data_uri(mime, &b));
    }

    let mut table = HashMap::new();
    let styles_text = styles.map(|s| String::from_utf8_lossy(&s).into_owned());
    if let Some(s) = &styles_text
        && let Ok(doc) = crate::xml_read::parse(s)
    {
        collect_styles(doc.root(), &mut table);
    }
    let content_text = String::from_utf8_lossy(&content).into_owned();
    let doc =
        crate::xml_read::parse(&content_text).map_err(|e| format!("Invalid ODT content: {e}"))?;
    collect_styles(doc.root(), &mut table);

    let mut ctx = Ctx {
        styles: table,
        resolved: HashMap::new(),
        pictures,
    };
    let body = doc
        .descendants()
        .find(|n| n.is_element() && qname(*n) == "office:body");
    let html = match body {
        Some(b) => {
            let text = b
                .children()
                .find(|c| c.is_element() && qname(*c) == "office:text")
                .unwrap_or(b);
            render_children(text, &mut ctx)
        }
        None => String::new(),
    };
    Ok(if html.is_empty() {
        "<p>(empty document)</p>".into()
    } else {
        html
    })
}
