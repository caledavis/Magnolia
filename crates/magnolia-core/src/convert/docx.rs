//! DOCX → semantic HTML (the role mammoth played in the TS build).
//!
//! Covers what matters for reading and coding a document: headings and
//! titles (by style name, so localised style ids work), bold / italic /
//! underline / strike / super- and subscript, bulleted and numbered lists
//! with nesting, tables with merged cells, hyperlinks, embedded images and
//! footnotes / endnotes. Empty paragraphs are dropped and deleted tracked
//! changes are skipped, as mammoth did.

use super::html::{data_uri, escape, escape_attr, image_mime};
use roxmltree::{Document, Node};
use std::collections::HashMap;
use std::io::{Cursor, Read};

const W: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

fn is(n: Node, local: &str) -> bool {
    n.is_element() && n.tag_name().name() == local && n.tag_name().namespace() == Some(W)
}

fn w_attr<'a>(n: Node<'a, '_>, local: &str) -> Option<&'a str> {
    n.attribute((W, local))
}

fn w_child<'a, 'i>(n: Node<'a, 'i>, local: &str) -> Option<Node<'a, 'i>> {
    n.children().find(|c| is(*c, local))
}

/// A `w:b`-style toggle: present and not explicitly off.
fn toggle(rpr: Option<Node>, local: &str) -> bool {
    rpr.and_then(|r| w_child(r, local))
        .is_some_and(|t| !matches!(w_attr(t, "val"), Some("0" | "false" | "none")))
}

struct Ctx<'a, 'i> {
    rels: HashMap<String, String>,
    media: HashMap<String, Vec<u8>>,
    style_names: HashMap<String, String>,
    /// numId → per-level "is bullet".
    numbering: HashMap<String, HashMap<String, bool>>,
    footnotes: Vec<(String, String)>,
    footnote_bodies: HashMap<String, Node<'a, 'i>>,
    endnote_bodies: HashMap<String, Node<'a, 'i>>,
}

fn read_entry(zip: &mut zip::ZipArchive<Cursor<&[u8]>>, name: &str) -> Option<String> {
    let mut f = zip.by_name(name).ok()?;
    let mut b = Vec::new();
    f.read_to_end(&mut b).ok()?;
    Some(String::from_utf8_lossy(&b).into_owned())
}

pub fn docx_to_html(bytes: &[u8]) -> Result<String, String> {
    let mut zip =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("Invalid DOCX: {e}"))?;
    let document =
        read_entry(&mut zip, "word/document.xml").ok_or("Invalid DOCX: no word/document.xml")?;
    let rels_xml = read_entry(&mut zip, "word/_rels/document.xml.rels").unwrap_or_default();
    let styles_xml = read_entry(&mut zip, "word/styles.xml").unwrap_or_default();
    let numbering_xml = read_entry(&mut zip, "word/numbering.xml").unwrap_or_default();
    let footnotes_xml = read_entry(&mut zip, "word/footnotes.xml").unwrap_or_default();
    let endnotes_xml = read_entry(&mut zip, "word/endnotes.xml").unwrap_or_default();

    let mut rels = HashMap::new();
    if let Ok(d) = Document::parse(&rels_xml) {
        for r in d
            .descendants()
            .filter(|n| n.tag_name().name() == "Relationship")
        {
            if let (Some(id), Some(t)) = (r.attribute("Id"), r.attribute("Target")) {
                rels.insert(id.to_string(), t.to_string());
            }
        }
    }
    let mut media = HashMap::new();
    for target in rels.values() {
        let path = if let Some(p) = target.strip_prefix('/') {
            p.to_string()
        } else {
            format!("word/{target}")
        };
        if let Ok(mut f) = zip.by_name(&path) {
            let mut b = Vec::new();
            if f.read_to_end(&mut b).is_ok() {
                media.insert(target.clone(), b);
            }
        }
    }

    let mut style_names = HashMap::new();
    if let Ok(d) = Document::parse(&styles_xml) {
        for s in d.descendants().filter(|n| is(*n, "style")) {
            if let (Some(id), Some(name)) = (
                w_attr(s, "styleId"),
                w_child(s, "name").and_then(|n| w_attr(n, "val")),
            ) {
                style_names.insert(id.to_string(), name.to_lowercase());
            }
        }
    }

    let mut numbering = HashMap::new();
    if let Ok(d) = Document::parse(&numbering_xml) {
        let mut abstracts: HashMap<String, HashMap<String, bool>> = HashMap::new();
        for a in d.descendants().filter(|n| is(*n, "abstractNum")) {
            let levels = a
                .children()
                .filter(|c| is(*c, "lvl"))
                .map(|l| {
                    let bullet =
                        w_child(l, "numFmt").and_then(|f| w_attr(f, "val")) == Some("bullet");
                    (w_attr(l, "ilvl").unwrap_or("0").to_string(), bullet)
                })
                .collect();
            abstracts.insert(w_attr(a, "abstractNumId").unwrap_or("").to_string(), levels);
        }
        for n in d.descendants().filter(|n| is(*n, "num")) {
            let abs = w_child(n, "abstractNumId")
                .and_then(|a| w_attr(a, "val"))
                .unwrap_or("");
            if let (Some(id), Some(levels)) = (w_attr(n, "numId"), abstracts.get(abs)) {
                numbering.insert(id.to_string(), levels.clone());
            }
        }
    }

    let doc = Document::parse(&document).map_err(|e| format!("Invalid DOCX document: {e}"))?;
    let fdoc = Document::parse(&footnotes_xml).ok();
    let edoc = Document::parse(&endnotes_xml).ok();

    let body = doc
        .descendants()
        .find(|n| is(*n, "body"))
        .ok_or("Invalid DOCX: no body")?;
    let mut ctx = Ctx {
        rels,
        media,
        style_names,
        numbering,
        footnotes: vec![],
        footnote_bodies: note_map(&fdoc, "footnote"),
        endnote_bodies: note_map(&edoc, "endnote"),
    };
    let mut html = render_blocks(body, &mut ctx);
    if !ctx.footnotes.is_empty() {
        html.push_str("<ol>");
        for (id, text) in std::mem::take(&mut ctx.footnotes) {
            html.push_str(&format!("<li id=\"footnote-{id}\">{text}</li>"));
        }
        html.push_str("</ol>");
    }
    Ok(html)
}

fn note_map<'a, 'i>(d: &'a Option<Document<'i>>, tag: &str) -> HashMap<String, Node<'a, 'i>> {
    d.as_ref()
        .map(|d| {
            d.descendants()
                .filter(|n| is(*n, tag))
                .filter_map(|n| w_attr(n, "id").map(|id| (id.to_string(), n)))
                .collect()
        })
        .unwrap_or_default()
}

/// Render a sequence of block elements, grouping list paragraphs.
fn render_blocks(parent: Node, ctx: &mut Ctx<'_, '_>) -> String {
    let mut out = String::new();
    // Open list levels (ordered?) and the numbering they belong to.
    let mut open: Vec<bool> = Vec::new();
    let mut list_id = String::new();
    let close_to = |open: &mut Vec<bool>, out: &mut String, depth: usize| {
        while open.len() > depth {
            out.push_str(if open.pop().unwrap() {
                "</li></ol>"
            } else {
                "</li></ul>"
            });
        }
    };
    for n in flatten_blocks(parent) {
        if is(n, "p") {
            let ppr = w_child(n, "pPr");
            let num = ppr.and_then(|p| w_child(p, "numPr"));
            let num_id = num
                .and_then(|x| w_child(x, "numId"))
                .and_then(|x| w_attr(x, "val"))
                .filter(|v| *v != "0");
            let content = render_inline(n, ctx);
            if let Some(num_id) = num_id {
                let level: usize = num
                    .and_then(|x| w_child(x, "ilvl"))
                    .and_then(|x| w_attr(x, "val"))
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0);
                let ordered = !ctx
                    .numbering
                    .get(num_id)
                    .and_then(|l| l.get(&level.to_string()))
                    .copied()
                    .unwrap_or(true);
                if list_id != num_id {
                    close_to(&mut open, &mut out, 0);
                    list_id = num_id.to_string();
                }
                close_to(&mut open, &mut out, level + 1);
                if open.len() == level + 1 {
                    out.push_str("</li><li>");
                }
                while open.len() < level + 1 {
                    out.push_str(if ordered { "<ol><li>" } else { "<ul><li>" });
                    open.push(ordered);
                }
                out.push_str(&content);
                continue;
            }
            list_id.clear();
            close_to(&mut open, &mut out, 0);
            if content.trim().is_empty() {
                continue;
            }
            let style = ppr
                .and_then(|p| w_child(p, "pStyle"))
                .and_then(|s| w_attr(s, "val"))
                .map(|id| {
                    ctx.style_names
                        .get(id)
                        .cloned()
                        .unwrap_or_else(|| id.to_lowercase())
                });
            let tag = match style.as_deref() {
                Some("title") => "h1".to_string(),
                Some(s) if s.starts_with("heading") => {
                    let lvl: usize = s.trim_start_matches("heading").trim().parse().unwrap_or(1);
                    format!("h{}", lvl.clamp(1, 6))
                }
                _ => "p".into(),
            };
            out.push_str(&format!("<{tag}>{content}</{tag}>"));
        } else if is(n, "tbl") {
            close_to(&mut open, &mut out, 0);
            out.push_str(&render_table(n, ctx));
        }
    }
    close_to(&mut open, &mut out, 0);
    out
}

/// Block children, descending through content controls and custom XML.
fn flatten_blocks<'a, 'i>(parent: Node<'a, 'i>) -> Vec<Node<'a, 'i>> {
    let mut v = Vec::new();
    for c in parent.children().filter(Node::is_element) {
        match c.tag_name().name() {
            "p" | "tbl" => v.push(c),
            "sdt" => v.extend(
                w_child(c, "sdtContent")
                    .map(flatten_blocks)
                    .unwrap_or_default(),
            ),
            "customXml" | "ins" => v.extend(flatten_blocks(c)),
            _ => {}
        }
    }
    v
}

fn render_table(tbl: Node, ctx: &mut Ctx<'_, '_>) -> String {
    struct Cell {
        html: String,
        colspan: usize,
        rowspan: usize,
        skip: bool,
    }
    let mut rows: Vec<Vec<Cell>> = Vec::new();
    // column index → (row, cell index) of the cell a vertical merge continues.
    let mut origin: HashMap<usize, (usize, usize)> = HashMap::new();
    for tr in tbl.children().filter(|c| is(*c, "tr")) {
        let ri = rows.len();
        let mut row = Vec::new();
        let mut col = 0;
        for tc in tr.children().filter(|c| is(*c, "tc")) {
            let pr = w_child(tc, "tcPr");
            let span: usize = pr
                .and_then(|p| w_child(p, "gridSpan"))
                .and_then(|g| w_attr(g, "val"))
                .and_then(|v| v.parse().ok())
                .unwrap_or(1);
            let vmerge = pr.and_then(|p| w_child(p, "vMerge"));
            let continues = vmerge.is_some_and(|v| w_attr(v, "val") != Some("restart"));
            if continues && let Some(&(r, c)) = origin.get(&col) {
                rows[r][c].rowspan += 1;
                row.push(Cell {
                    html: String::new(),
                    colspan: span,
                    rowspan: 1,
                    skip: true,
                });
            } else {
                origin.insert(col, (ri, row.len()));
                row.push(Cell {
                    html: render_blocks(tc, ctx),
                    colspan: span,
                    rowspan: 1,
                    skip: false,
                });
            }
            col += span;
        }
        rows.push(row);
    }
    let mut out = String::from("<table>");
    for row in rows {
        out.push_str("<tr>");
        for c in row.into_iter().filter(|c| !c.skip) {
            let mut attrs = String::new();
            if c.colspan > 1 {
                attrs.push_str(&format!(" colspan=\"{}\"", c.colspan));
            }
            if c.rowspan > 1 {
                attrs.push_str(&format!(" rowspan=\"{}\"", c.rowspan));
            }
            out.push_str(&format!("<td{attrs}>{}</td>", c.html));
        }
        out.push_str("</tr>");
    }
    out.push_str("</table>");
    out
}

/// Inline content of a paragraph (runs, links, fields, images).
fn render_inline(n: Node, ctx: &mut Ctx<'_, '_>) -> String {
    let mut out = String::new();
    for c in n.children().filter(Node::is_element) {
        match c.tag_name().name() {
            "r" => out.push_str(&render_run(c, ctx)),
            "hyperlink" => {
                let inner = render_inline(c, ctx);
                let href = c
                    .attribute((R, "id"))
                    .and_then(|id| ctx.rels.get(id).cloned())
                    .or_else(|| w_attr(c, "anchor").map(|a| format!("#{a}")));
                match href {
                    Some(h) => {
                        out.push_str(&format!("<a href=\"{}\">{inner}</a>", escape_attr(&h)))
                    }
                    None => out.push_str(&inner),
                }
            }
            "del" | "moveFrom" | "pPr" | "proofErr" | "bookmarkStart" | "bookmarkEnd" => {}
            "sdt" => {
                if let Some(content) = w_child(c, "sdtContent") {
                    out.push_str(&render_inline(content, ctx));
                }
            }
            // ins, smartTag, fldSimple, customXml, moveTo …: keep their runs.
            _ => out.push_str(&render_inline(c, ctx)),
        }
    }
    out
}

fn render_run(r: Node, ctx: &mut Ctx<'_, '_>) -> String {
    let mut text = String::new();
    for c in r.children().filter(Node::is_element) {
        match c.tag_name().name() {
            "t" => text.push_str(&escape(c.text().unwrap_or(""))),
            "tab" => text.push('\t'),
            "br" | "cr" => {
                if w_attr(c, "type") != Some("page") {
                    text.push_str("<br />")
                }
            }
            "noBreakHyphen" => text.push('\u{2011}'),
            "softHyphen" => text.push('\u{00AD}'),
            "sym" => {
                if let Some(ch) = w_attr(c, "char")
                    .and_then(|h| u32::from_str_radix(h, 16).ok())
                    .and_then(char::from_u32)
                {
                    text.push(ch);
                }
            }
            "drawing" | "pict" | "object" => {
                for img in c.descendants().filter(|d| d.is_element()) {
                    let id = match img.tag_name().name() {
                        "blip" => img.attribute((R, "embed")),
                        "imagedata" => img.attribute((R, "id")),
                        _ => None,
                    };
                    if let Some(target) = id.and_then(|id| ctx.rels.get(id))
                        && let Some(bytes) = ctx.media.get(target)
                    {
                        let alt = c
                            .descendants()
                            .find(|d| d.tag_name().name() == "docPr")
                            .and_then(|d| d.attribute("descr"))
                            .unwrap_or("");
                        let src = data_uri(image_mime(&crate::util::ext_of(target)), bytes);
                        text.push_str(&format!(
                            "<img src=\"{src}\" alt=\"{}\" />",
                            escape_attr(alt)
                        ));
                    }
                }
            }
            "footnoteReference" | "endnoteReference" => {
                let foot = c.tag_name().name() == "footnoteReference";
                if let Some(id) = w_attr(c, "id") {
                    let body = if foot {
                        ctx.footnote_bodies.get(id)
                    } else {
                        ctx.endnote_bodies.get(id)
                    }
                    .copied();
                    let n = ctx.footnotes.len() + 1;
                    let key = format!("{}-{id}", if foot { "fn" } else { "en" });
                    let content = body.map(|b| render_blocks(b, ctx)).unwrap_or_default();
                    ctx.footnotes.push((key.clone(), content));
                    text.push_str(&format!("<sup><a href=\"#footnote-{key}\">[{n}]</a></sup>"));
                }
            }
            _ => {}
        }
    }
    if text.is_empty() {
        return text;
    }
    let rpr = w_child(r, "rPr");
    let valign = rpr
        .and_then(|p| w_child(p, "vertAlign"))
        .and_then(|v| w_attr(v, "val"));
    if valign == Some("superscript") {
        text = format!("<sup>{text}</sup>");
    } else if valign == Some("subscript") {
        text = format!("<sub>{text}</sub>");
    }
    if toggle(rpr, "strike") || toggle(rpr, "dstrike") {
        text = format!("<s>{text}</s>");
    }
    if toggle(rpr, "u") {
        text = format!("<u>{text}</u>");
    }
    if toggle(rpr, "i") {
        text = format!("<em>{text}</em>");
    }
    if toggle(rpr, "b") {
        text = format!("<strong>{text}</strong>");
    }
    text
}
