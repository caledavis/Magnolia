//! Word, RTF and ODT imports → PDF, typeset with Typst.
//!
//! The converters turn each format into simple HTML; this module turns that
//! HTML into Typst markup, typesets it and writes the PDF. Alongside the PDF
//! it records the document's exact text and where each run of it sits on the
//! page (the "text layer"), and attaches that to the PDF as
//! `magnolia-text-layer.json`. Magnolia reads its text from that attachment
//! instead of from the PDF's drawn glyphs, which can't be read back reliably
//! for scripts that join or reorder letters (Arabic, Hebrew, Devanagari…).
//!
//! The text comes straight from the layout: every glyph Typst places knows
//! where in the markup it came from, so sorting a page's text runs by that
//! position gives the reading order, whatever the script's direction. All
//! document text is written into the markup as string literals, so nothing
//! in a document can be read as Typst syntax.

use super::html_dom::{self, Element, Node};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fmt::Write as _;
use std::ops::Range;
use std::sync::OnceLock;
use typst::diag::{FileError, FileResult};
use typst::foundations::{Bytes, Datetime, Duration, Smart};
use typst::layout::{Frame, FrameItem, Transform};
use typst::syntax::{FileId, RootedPath, Source, Span, VirtualPath, VirtualRoot};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Library, LibraryExt, World, WorldExt};
use typst_kit::fonts::FontStore;
use typst_layout::PagedDocument;

/// The PDF attachment holding the text layer (read by the renderer's
/// `pdf-page-text.ts`).
pub const TEXT_LAYER_NAME: &str = "magnolia-text-layer.json";

/// Typeset converted HTML as a PDF that carries its own text layer. A
/// failure is reported in plain words (Typst's own messages describe its
/// markup, which people never see).
pub fn html_to_pdf(html: &str) -> Result<Vec<u8>, String> {
    typeset_pdf(html).map_err(|detail| {
        eprintln!("typesetting failed: {detail}");
        crate::message::tr(
            "typesetFailed",
            "Magnolia couldn’t lay this document out as pages. Try saving it again in the program it came from, or saving it as a PDF and importing that.",
            &[],
        )
    })
}

fn typeset_pdf(html: &str) -> Result<Vec<u8>, String> {
    let doc = markup(html);
    let mut world = DocWorld::new(&doc.source, &doc.files);
    let first = compile(&world)?;
    let layer = text_layer(&first, &world, &doc.leaves);
    let layer_json = serde_json::to_vec(&layer).map_err(|e| e.to_string())?;

    // Typeset again with the layer attached. Attaching changes nothing on
    // the page, so the layer still fits; check that anyway.
    let attach = format!(
        "\n#pdf.attach(\"{TEXT_LAYER_NAME}\", read(\"{TEXT_LAYER_NAME}\", encoding: none), mime-type: \"application/json\")\n"
    );
    world.set_main(&format!("{}{attach}", doc.source));
    world.add_file(TEXT_LAYER_NAME, layer_json);
    let second = compile(&world)?;
    if text_layer(&second, &world, &doc.leaves) != layer {
        return Err("The document's layout changed while it was being written as a PDF.".into());
    }
    let options = typst_pdf::PdfOptions { creator: Smart::Custom(Some("Magnolia".into())), ..Default::default() };
    typst_pdf::pdf(&second, &options).map_err(|errs| errs.iter().map(|e| e.message.to_string()).collect::<Vec<_>>().join("; "))
}

/// The text a layer holds, joined as the renderer joins it (a newline after
/// each line, one between pages). For tests and the developer tool.
pub fn layer_text(layer: &Value) -> String {
    let mut pages = Vec::new();
    for page in layer["pages"].as_array().into_iter().flatten() {
        let mut s = String::new();
        for item in page["items"].as_array().into_iter().flatten() {
            s.push_str(item["s"].as_str().unwrap_or(""));
            if item.get("e").is_some() {
                s.push('\n');
            }
        }
        pages.push(s);
    }
    pages.join("\n")
}

/// Typeset `html` and return its text layer without writing a PDF (tests).
pub fn html_text_layer(html: &str) -> Result<Value, String> {
    let doc = markup(html);
    let world = DocWorld::new(&doc.source, &doc.files);
    let typeset = compile(&world)?;
    Ok(text_layer(&typeset, &world, &doc.leaves))
}

// ── The Typst world ──────────────────────────────────────────────────

fn fonts() -> &'static FontStore {
    static FONTS: OnceLock<FontStore> = OnceLock::new();
    FONTS.get_or_init(|| {
        let mut store = FontStore::new();
        store.extend(typst_kit::fonts::system());
        store
    })
}

fn library() -> &'static LazyHash<Library> {
    static LIBRARY: OnceLock<LazyHash<Library>> = OnceLock::new();
    LIBRARY.get_or_init(|| LazyHash::new(<Library as LibraryExt>::default()))
}

fn file_id(name: &str) -> FileId {
    RootedPath::new(VirtualRoot::Project, VirtualPath::new(format!("/{name}")).expect("valid file name")).intern()
}

struct DocWorld {
    main: Source,
    files: HashMap<FileId, Bytes>,
}

impl DocWorld {
    fn new(source: &str, files: &[(String, Vec<u8>)]) -> Self {
        let files = files.iter().map(|(name, bytes)| (file_id(name), Bytes::new(bytes.clone()))).collect();
        DocWorld { main: Source::new(file_id("main.typ"), source.to_string()), files }
    }

    fn set_main(&mut self, source: &str) {
        self.main = Source::new(file_id("main.typ"), source.to_string());
    }

    fn add_file(&mut self, name: &str, bytes: Vec<u8>) {
        self.files.insert(file_id(name), Bytes::new(bytes));
    }
}

impl World for DocWorld {
    fn library(&self) -> &LazyHash<Library> {
        library()
    }

    fn book(&self) -> &LazyHash<FontBook> {
        fonts().book()
    }

    fn main(&self) -> FileId {
        self.main.id()
    }

    fn source(&self, id: FileId) -> FileResult<Source> {
        if id == self.main.id() {
            Ok(self.main.clone())
        } else {
            Err(FileError::NotSource)
        }
    }

    fn file(&self, id: FileId) -> FileResult<Bytes> {
        if id == self.main.id() {
            return Ok(Bytes::from_string(self.main.clone()));
        }
        self.files.get(&id).cloned().ok_or(FileError::AccessDenied)
    }

    fn font(&self, index: usize) -> Option<Font> {
        fonts().font(index)
    }

    fn today(&self, _offset: Option<Duration>) -> Option<Datetime> {
        None
    }
}

fn compile(world: &DocWorld) -> Result<PagedDocument, String> {
    typst::compile::<PagedDocument>(world)
        .output
        .map_err(|errs| errs.iter().map(|e| e.message.to_string()).collect::<Vec<_>>().join("; "))
}

// ── The text layer ───────────────────────────────────────────────────

struct Run {
    text: String,
    /// Left end of the baseline, in points from the page's top-left.
    x: f64,
    y: f64,
    width: f64,
    size: f64,
    /// Where in the markup the run's text starts.
    key: usize,
    /// The paragraph (or cell, heading…) it belongs to.
    leaf: usize,
    /// The markup nodes its text starts and ends in.
    first_node: Option<Span>,
    last_node: Option<Span>,
}

fn text_layer(doc: &PagedDocument, world: &DocWorld, leaves: &[Range<usize>]) -> Value {
    let mut seen = std::collections::HashSet::new();
    let pages: Vec<Value> = doc
        .pages()
        .iter()
        .map(|page| {
            let mut runs = Vec::new();
            collect_runs(&page.frame, Transform::identity(), world, &mut seen, &mut runs);
            // Text Typst made up (none, as the markup is written) takes the
            // place of the run before it.
            let mut last = 0;
            let mut placed: Vec<(Run, usize)> = Vec::new();
            for (run, key) in runs {
                let key = key.unwrap_or(last);
                last = key;
                placed.push((run, key));
            }
            let mut runs: Vec<Run> = placed
                .into_iter()
                .map(|(mut r, key)| {
                    r.key = key;
                    r.leaf = leaf_of(leaves, key);
                    r
                })
                .collect();
            runs.sort_by_key(|r| r.key);
            page_items(&runs, page.frame.height().to_pt())
        })
        .collect();
    json!({ "version": 1, "pages": pages })
}

/// Each text run on a page with where its text starts in the markup.
/// A run's text is rebuilt from its glyph clusters, and a cluster already
/// taken is skipped: when a cluster's marks come from another font than
/// its letter, Typst splits it into two runs that both carry its text.
fn collect_runs(
    frame: &Frame,
    ts: Transform,
    world: &DocWorld,
    seen: &mut std::collections::HashSet<usize>,
    out: &mut Vec<(Run, Option<usize>)>,
) {
    for (pos, item) in frame.items() {
        match item {
            FrameItem::Group(group) => {
                let ts = ts.pre_concat(Transform::translate(pos.x, pos.y)).pre_concat(group.transform);
                collect_runs(&group.frame, ts, world, seen, out);
            }
            FrameItem::Text(text) if !text.text.is_empty() => {
                // Clusters (text ranges) with their markup positions.
                let mut clusters: Vec<(Range<usize>, Option<(usize, Span)>)> = Vec::new();
                for g in &text.glyphs {
                    let key = world.range(g.span.0).map(|r| (r.start + usize::from(g.span.1), g.span.0));
                    match clusters.iter_mut().find(|(r, _)| *r == g.range()) {
                        Some((_, k)) => *k = match (*k, key) {
                            (Some(a), Some(b)) => Some(if b.0 < a.0 { b } else { a }),
                            (a, b) => a.or(b),
                        },
                        None => clusters.push((g.range(), key)),
                    }
                }
                clusters.sort_by_key(|(r, _)| r.start);
                let mut s = String::new();
                let mut first: Option<(usize, Span)> = None;
                let mut last: Option<(usize, Span)> = None;
                for (range, key) in clusters {
                    if let Some(k) = key {
                        if !seen.insert(k.0) {
                            continue;
                        }
                        if first.is_none_or(|f| k.0 < f.0) {
                            first = Some(k);
                        }
                        if last.is_none_or(|l| k.0 > l.0) {
                            last = Some(k);
                        }
                    }
                    s.push_str(text.text.get(range).unwrap_or(""));
                }
                if s.is_empty() {
                    continue;
                }
                let at = pos.transform(ts);
                out.push((
                    Run {
                        text: s,
                        x: at.x.to_pt(),
                        y: at.y.to_pt(),
                        width: text.width().to_pt(),
                        size: text.size.to_pt(),
                        key: 0,
                        leaf: usize::MAX,
                        first_node: first.map(|f| f.1),
                        last_node: last.map(|l| l.1),
                    },
                    first.map(|f| f.0),
                ));
            }
            _ => {}
        }
    }
}

fn leaf_of(leaves: &[Range<usize>], key: usize) -> usize {
    let i = leaves.partition_point(|r| r.end <= key);
    if leaves.get(i).is_some_and(|r| r.start <= key) { i } else { usize::MAX }
}

/// A page's runs (in reading order) as layer items: a line ends where the
/// paragraph changes or the baseline moves; a space is added where two
/// pieces of markup sit apart with no space between them (a list marker
/// and its text). Within one piece the text has its own spaces.
fn page_items(runs: &[Run], page_height: f64) -> Value {
    let round = |v: f64| (v * 100.0).round() / 100.0;
    let item = |s: &str, x: f64, y: f64, w: f64, size: f64| {
        let mut o = json!({ "s": s, "x": round(x), "y": round(page_height - y), "w": round(w), "h": round(size) });
        if is_rtl(s) {
            o["d"] = "rtl".into();
        }
        o
    };
    let mut items: Vec<Value> = Vec::new();
    for (i, run) in runs.iter().enumerate() {
        if let Some(prev) = i.checked_sub(1).map(|j| &runs[j]) {
            let size = prev.size.max(run.size);
            let new_line = run.leaf != prev.leaf || (run.y - prev.y).abs() > 0.5 * size;
            if new_line {
                items.last_mut().unwrap()["e"] = 1.into();
            } else {
                let (a, b) = ((prev.x, prev.x + prev.width), (run.x, run.x + run.width));
                let gap_from = a.1.min(b.1);
                let gap_to = a.0.max(b.0);
                let spaced = prev.text.ends_with(char::is_whitespace) || run.text.starts_with(char::is_whitespace);
                let same_node = prev.last_node.is_some() && prev.last_node == run.first_node;
                if gap_to - gap_from > 0.2 * size && !spaced && !same_node {
                    items.push(item(" ", gap_from, run.y, gap_to - gap_from, run.size));
                }
            }
        }
        items.push(item(&run.text, run.x, run.y, run.width, run.size));
    }
    json!({ "items": items })
}

fn is_rtl(s: &str) -> bool {
    s.chars().find(|c| c.is_alphabetic()).is_some_and(is_rtl_char)
}

fn is_rtl_char(c: char) -> bool {
    matches!(c as u32,
        0x0590..=0x08FF | 0xFB1D..=0xFDFF | 0xFE70..=0xFEFF | 0x10800..=0x10FFF | 0x1E800..=0x1EFFF)
}

// ── HTML → Typst markup ──────────────────────────────────────────────

const PREAMBLE: &str = r##"#set page(width: 8.5in, height: 11in, margin: 0.4in)
#let body-fonts = ("Helvetica Neue", "Segoe UI", "Roboto", "Helvetica", "Arial", "Noto Sans", "Liberation Sans", "DejaVu Sans", "Geeza Pro", "Noto Sans Arabic", "Noto Naskh Arabic", "Arial Hebrew", "Noto Sans Hebrew", "Kohinoor Devanagari", "Nirmala UI", "Noto Sans Devanagari", "PingFang SC", "Hiragino Sans", "Microsoft YaHei", "Noto Sans CJK SC", "Apple SD Gothic Neo", "Malgun Gothic", "Thonburi", "Leelawadee UI", "Noto Sans Thai")
#set text(font: body-fonts, size: 12pt, hyphenate: false)
#set par(leading: 0.8em, spacing: 1.3em)
#set table(stroke: 0.75pt + rgb("#cccccc"), inset: (x: 6pt, y: 4pt))
#show heading: it => block(above: 1.2em, below: 0.9em, sticky: true, text(size: (2em, 1.5em, 1.17em, 1em, 0.83em, 0.67em).at(calc.min(it.level, 6) - 1), weight: "bold", it.body))
#let fit-image(path, width) = box(layout(size => image(path, width: calc.min(width, size.width))))
#let fit-image-auto(path) = box(layout(size => { let i = image(path); if measure(i).width > size.width { image(path, width: size.width) } else { i } }))
"##;

struct Doc {
    source: String,
    files: Vec<(String, Vec<u8>)>,
    /// The markup ranges of each paragraph-like block's text, in order.
    leaves: Vec<Range<usize>>,
}

fn markup(html: &str) -> Doc {
    let nodes = html_dom::parse(html);
    let mut w = Writer { s: PREAMBLE.to_string(), leaves: vec![], files: vec![] };
    w.blocks(&nodes, &BlockStyle::default());
    Doc { source: w.s, files: w.files, leaves: w.leaves }
}

#[derive(Clone, Default, PartialEq)]
struct Style {
    bold: Option<bool>,
    italic: bool,
    underline: bool,
    strike: bool,
    sup: bool,
    sub: bool,
    link: Option<String>,
    color: Option<String>,
    background: Option<String>,
    size: Option<String>,
    font: Option<String>,
}

#[derive(Clone, Default)]
struct BlockStyle {
    align: Option<&'static str>,
    indent: Option<String>,
    bold: bool,
}

enum Inline {
    Text(String, Style),
    Break,
    Image(String, Option<f64>),
}

struct Writer {
    s: String,
    leaves: Vec<Range<usize>>,
    files: Vec<(String, Vec<u8>)>,
}

fn is_block(name: &str) -> bool {
    matches!(
        name,
        "p" | "div" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "ul" | "ol" | "li" | "table" | "thead" | "tbody"
            | "tfoot" | "tr" | "td" | "th" | "blockquote" | "hr" | "pre" | "section" | "article" | "body" | "html"
    )
}

fn element(n: &Node) -> Option<&Element> {
    match n {
        Node::Element(e) => Some(e),
        Node::Text(_) => None,
    }
}

impl Writer {
    /// Block content: runs of inline content become paragraphs.
    fn blocks(&mut self, nodes: &[Node], style: &BlockStyle) {
        let mut pending: Vec<&Node> = Vec::new();
        for n in nodes {
            match element(n) {
                Some(e) if is_block(&e.name) => {
                    self.paragraph(&pending, style, None, false);
                    pending.clear();
                    self.block(e, style);
                }
                _ => pending.push(n),
            }
        }
        self.paragraph(&pending, style, None, false);
    }

    fn block(&mut self, e: &Element, style: &BlockStyle) {
        let style = block_style(e, style);
        match e.name.as_str() {
            "p" | "pre" => {
                let kids: Vec<&Node> = e.children.iter().collect();
                if kids.iter().any(|n| element(n).is_some_and(|c| is_block(&c.name))) {
                    self.blocks(&e.children, &style);
                } else {
                    self.paragraph(&kids, &style, None, true);
                }
            }
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                let level = &e.name[1..];
                let runs = self.inline_runs(&e.children.iter().collect::<Vec<_>>(), &Style::default());
                if !has_text(&runs) {
                    return;
                }
                let rtl = is_rtl_runs(&runs);
                write!(self.s, "#heading(level: {level})[").unwrap();
                if rtl {
                    self.s.push_str("#set text(dir: rtl);");
                }
                self.leaf(&runs);
                self.s.push_str("]\n\n");
            }
            "ul" | "ol" => self.list(e, &style, 0),
            "table" => self.table(e),
            "blockquote" => {
                self.s.push_str("#pad(x: 2em)[");
                self.blocks(&e.children, &style);
                self.s.push_str("]\n\n");
            }
            "hr" => self.s.push_str("#line(length: 100%, stroke: 0.5pt + rgb(\"#999999\"))\n\n"),
            _ => self.blocks(&e.children, &style),
        }
    }

    /// One paragraph. `marker` starts it with a list marker; `keep_blank`
    /// keeps an empty paragraph as a blank line (as the source showed it).
    fn paragraph(&mut self, nodes: &[&Node], style: &BlockStyle, marker: Option<(&str, usize)>, keep_blank: bool) {
        let base = Style { bold: style.bold.then_some(true), ..Style::default() };
        let runs = self.inline_runs(nodes, &base);
        if !has_text(&runs) && marker.is_none() {
            if keep_blank && !nodes.is_empty() {
                self.s.push_str("#v(1.3em)\n\n");
            }
            return;
        }
        let rtl = is_rtl_runs(&runs);
        self.s.push_str("#[");
        if rtl {
            self.s.push_str("#set text(dir: rtl);");
        }
        let mut closes = String::new();
        if let Some(align) = style.align {
            write!(self.s, "#align({align})[").unwrap();
            closes.push(']');
        }
        let side = if rtl { "right" } else { "left" };
        if let Some(indent) = &style.indent {
            write!(self.s, "#pad({side}: {indent})[").unwrap();
            closes.push(']');
        }
        match marker {
            Some((marker, depth)) => {
                write!(self.s, "#pad({side}: {}em)[#par(hanging-indent: 1.4em)[", depth as f64 * 1.4).unwrap();
                let start = self.s.len();
                write!(self.s, "#box(width: 1.4em)[#{}]", string_literal(marker)).unwrap();
                self.leaf_from(start, &runs);
                self.s.push_str("]]");
            }
            None => self.leaf(&runs),
        }
        self.s.push_str(&closes);
        self.s.push_str("]\n\n");
    }

    fn leaf(&mut self, runs: &[Inline]) {
        let start = self.s.len();
        self.leaf_from(start, runs);
    }

    fn leaf_from(&mut self, start: usize, runs: &[Inline]) {
        for run in runs {
            match run {
                Inline::Text(text, style) => write_text(&mut self.s, text, style),
                Inline::Break => self.s.push_str("#linebreak()"),
                Inline::Image(path, Some(width)) => {
                    write!(self.s, "#fit-image({}, {:.2}pt)", string_literal(path), width).unwrap()
                }
                Inline::Image(path, None) => write!(self.s, "#fit-image-auto({})", string_literal(path)).unwrap(),
            }
        }
        self.leaves.push(start..self.s.len());
    }

    fn list(&mut self, e: &Element, style: &BlockStyle, depth: usize) {
        let ordered = e.name == "ol";
        let mut number: i64 = e.attr("start").and_then(|s| s.trim().parse().ok()).unwrap_or(1);
        let bullet = ["•", "◦", "▪"][depth % 3];
        for child in &e.children {
            let Some(li) = element(child).filter(|c| c.name == "li") else {
                match element(child) {
                    Some(c) if c.name == "ul" || c.name == "ol" => self.list(c, style, depth + 1),
                    Some(c) if is_block(&c.name) => self.block(c, style),
                    _ => self.paragraph(&[child], style, None, false),
                }
                continue;
            };
            let marker = if ordered { format!("{number}.") } else { bullet.to_string() };
            number += 1;
            // The marker goes on the item's first paragraph: its leading
            // inline content, or its first <p>.
            let kids: Vec<&Node> = li.children.iter().collect();
            let first_block = kids.iter().position(|n| element(n).is_some_and(|c| is_block(&c.name)));
            let (lead, rest): (Vec<&Node>, &[&Node]) = match first_block {
                Some(i) if inline_is_blank(&kids[..i]) && element(kids[i]).is_some_and(|c| c.name == "p") => {
                    (element(kids[i]).unwrap().children.iter().collect(), &kids[i + 1..])
                }
                Some(i) => (kids[..i].to_vec(), &kids[i..]),
                None => (kids.clone(), &[]),
            };
            let item_style = block_style(li, style);
            // An item with no text of its own (an empty one, or one that
            // only holds a nested list) gets no marker line.
            if lead.iter().any(|n| has_content(n)) {
                self.paragraph(&lead, &item_style, Some((&marker, depth)), false);
            } else if ordered {
                number -= 1;
            }
            for n in rest {
                match element(n) {
                    Some(c) if c.name == "ul" || c.name == "ol" => self.list(c, &item_style, depth + 1),
                    Some(c) if is_block(&c.name) => {
                        write!(self.s, "#pad(x: {}em)[", (depth + 1) as f64 * 1.4).unwrap();
                        self.block(c, &item_style);
                        self.s.push_str("]\n\n");
                    }
                    _ => self.paragraph(&[n], &item_style, None, false),
                }
            }
        }
    }

    fn table(&mut self, e: &Element) {
        // Rows, through thead / tbody / tfoot; header rows are bold.
        let mut rows: Vec<(&Element, bool)> = Vec::new();
        fn gather<'a>(e: &'a Element, header: bool, rows: &mut Vec<(&'a Element, bool)>) {
            for c in e.children.iter().filter_map(element) {
                match c.name.as_str() {
                    "tr" => rows.push((c, header)),
                    "thead" => gather(c, true, rows),
                    "tbody" | "tfoot" => gather(c, header, rows),
                    _ => {}
                }
            }
        }
        gather(e, false, &mut rows);
        let cell_span = |c: &Element, k: &str| c.attr(k).and_then(|v| v.trim().parse::<usize>().ok()).unwrap_or(1).max(1);
        // Count columns, allowing for cells that span rows.
        let mut busy: HashMap<(usize, usize), ()> = HashMap::new();
        let mut columns = 1;
        for (r, (tr, _)) in rows.iter().enumerate() {
            let mut col = 0;
            for td in tr.children.iter().filter_map(element).filter(|c| c.name == "td" || c.name == "th") {
                while busy.contains_key(&(r, col)) {
                    col += 1;
                }
                let (cs, rs) = (cell_span(td, "colspan"), cell_span(td, "rowspan"));
                for dr in 0..rs {
                    for dc in 0..cs {
                        busy.insert((r + dr, col + dc), ());
                    }
                }
                col += cs;
                columns = columns.max(col);
            }
        }
        if rows.is_empty() {
            return;
        }
        let rtl = is_rtl(&element_text(e));
        self.s.push_str("#[");
        if rtl {
            self.s.push_str("#set text(dir: rtl);");
        }
        write!(self.s, "#table(columns: (1fr,) * {columns}").unwrap();
        for (tr, header) in rows {
            for td in tr.children.iter().filter_map(element).filter(|c| c.name == "td" || c.name == "th") {
                let (cs, rs) = (cell_span(td, "colspan"), cell_span(td, "rowspan"));
                write!(self.s, ", table.cell(colspan: {cs}, rowspan: {rs})[").unwrap();
                let style = BlockStyle { bold: header || td.name == "th", ..block_style(td, &BlockStyle::default()) };
                self.blocks(&td.children, &style);
                self.s.push(']');
            }
        }
        self.s.push_str(")]\n\n");
    }

    /// A paragraph's inline content as styled runs, with HTML's whitespace
    /// rules applied (runs of spaces collapse; none at either end).
    fn inline_runs(&mut self, nodes: &[&Node], base: &Style) -> Vec<Inline> {
        let mut runs = Vec::new();
        for n in nodes {
            self.flatten(n, base, &mut runs);
        }
        collapse_whitespace(runs)
    }

    fn flatten(&mut self, n: &Node, style: &Style, out: &mut Vec<Inline>) {
        match n {
            Node::Text(t) => out.push(Inline::Text(t.clone(), style.clone())),
            Node::Element(e) => match e.name.as_str() {
                "br" => out.push(Inline::Break),
                "img" => {
                    if let Some(img) = e.attr("src").and_then(|src| self.image(src)) {
                        out.push(img);
                    }
                }
                "script" | "style" | "head" | "title" => {}
                _ => {
                    let style = inline_style(e, style);
                    for c in &e.children {
                        self.flatten(c, &style, out);
                    }
                }
            },
        }
    }

    /// An `<img>`'s data URI as a file for Typst, with its width in points
    /// (CSS pixels, as the browser showed it).
    fn image(&mut self, src: &str) -> Option<Inline> {
        use base64::Engine;
        let (meta, data) = src.strip_prefix("data:")?.split_once(',')?;
        if !meta.ends_with(";base64") {
            return None;
        }
        let bytes = base64::engine::general_purpose::STANDARD.decode(data.trim()).ok()?;
        let n = self.files.len() + 1;
        let head = String::from_utf8_lossy(&bytes[..bytes.len().min(256)]).to_string();
        if meta.contains("svg") || head.trim_start().starts_with("<svg") || head.trim_start().starts_with("<?xml") {
            let name = format!("image{n}.svg");
            self.files.push((name.clone(), bytes));
            return Some(Inline::Image(name, None));
        }
        let format = ::image::guess_format(&bytes).ok()?;
        let (bytes, ext) = match format {
            ::image::ImageFormat::Png => (bytes, "png"),
            ::image::ImageFormat::Jpeg => (bytes, "jpg"),
            ::image::ImageFormat::Gif => (bytes, "gif"),
            // Other formats are re-encoded as PNG.
            _ => {
                let img = ::image::load_from_memory(&bytes).ok()?;
                let mut png = Vec::new();
                img.write_to(&mut std::io::Cursor::new(&mut png), ::image::ImageFormat::Png).ok()?;
                (png, "png")
            }
        };
        let width = ::image::ImageReader::new(std::io::Cursor::new(&bytes))
            .with_guessed_format()
            .ok()
            .and_then(|r| r.into_dimensions().ok())
            .map(|(w, _)| w as f64 * 0.75);
        let name = format!("image{n}.{ext}");
        self.files.push((name.clone(), bytes));
        Some(Inline::Image(name, width))
    }
}

fn has_text(runs: &[Inline]) -> bool {
    runs.iter().any(|r| match r {
        Inline::Text(t, _) => t.chars().any(|c| !c.is_whitespace()),
        Inline::Image(..) => true,
        Inline::Break => false,
    })
}

/// Whether a node holds visible text or an image.
fn has_content(n: &Node) -> bool {
    match n {
        Node::Text(t) => t.chars().any(|c| !c.is_whitespace()),
        Node::Element(e) => e.name == "img" || e.children.iter().any(has_content),
    }
}

fn inline_is_blank(nodes: &[&Node]) -> bool {
    nodes.iter().all(|n| matches!(n, Node::Text(t) if t.trim().is_empty()))
}

fn is_rtl_runs(runs: &[Inline]) -> bool {
    let text: String = runs.iter().filter_map(|r| if let Inline::Text(t, _) = r { Some(t.as_str()) } else { None }).collect();
    is_rtl(&text)
}

fn element_text(e: &Element) -> String {
    let mut s = String::new();
    for c in &e.children {
        match c {
            Node::Text(t) => s.push_str(t),
            Node::Element(c) => s.push_str(&element_text(c)),
        }
    }
    s
}

fn collapse_whitespace(runs: Vec<Inline>) -> Vec<Inline> {
    let is_html_space = |c: char| matches!(c, ' ' | '\t' | '\n' | '\r' | '\x0c');
    let mut out: Vec<Inline> = Vec::new();
    // Whether the text so far ends in a space (or is at a line start).
    let mut at_space = true;
    for run in runs {
        match run {
            Inline::Text(t, style) => {
                let mut s = String::with_capacity(t.len());
                for c in t.chars() {
                    if is_html_space(c) {
                        if !at_space {
                            s.push(' ');
                            at_space = true;
                        }
                    } else if !c.is_control() {
                        s.push(c);
                        at_space = false;
                    }
                }
                if !s.is_empty() {
                    out.push(Inline::Text(s, style));
                }
            }
            Inline::Break => {
                trim_end(&mut out);
                out.push(Inline::Break);
                at_space = true;
            }
            img => {
                out.push(img);
                at_space = false;
            }
        }
    }
    trim_end(&mut out);
    out
}

fn trim_end(out: &mut Vec<Inline>) {
    while let Some(Inline::Text(t, _)) = out.last_mut() {
        let trimmed = t.trim_end_matches(' ').len();
        t.truncate(trimmed);
        if t.is_empty() {
            out.pop();
        } else {
            break;
        }
    }
}

fn block_style(e: &Element, parent: &BlockStyle) -> BlockStyle {
    let mut s = BlockStyle { indent: None, ..parent.clone() };
    if let Some(a) = e.style("text-align").or_else(|| e.attr("align").map(str::to_string)) {
        s.align = match a.to_ascii_lowercase().as_str() {
            "center" => Some("center"),
            "right" => Some("right"),
            "left" => Some("left"),
            "end" => Some("end"),
            "start" => Some("start"),
            "justify" => None,
            _ => s.align,
        };
    }
    s.indent = e.style("margin-left").and_then(|v| css_length(&v)).filter(|v| !v.starts_with('-') && v != "0pt");
    s
}

fn inline_style(e: &Element, parent: &Style) -> Style {
    let mut s = parent.clone();
    match e.name.as_str() {
        "strong" | "b" => s.bold = Some(true),
        "em" | "i" | "cite" | "dfn" => s.italic = true,
        "u" | "ins" => s.underline = true,
        "s" | "strike" | "del" => s.strike = true,
        "sup" => s.sup = true,
        "sub" => s.sub = true,
        "code" | "kbd" | "samp" | "tt" => s.font = Some("Menlo\", \"Consolas\", \"DejaVu Sans Mono".into()),
        "a" => {
            if let Some(href) = e.attr("href").filter(|h| {
                let h = h.to_ascii_lowercase();
                h.starts_with("http://") || h.starts_with("https://") || h.starts_with("mailto:")
            }) {
                s.link = Some(href.to_string());
            }
        }
        _ => {}
    }
    if let Some(w) = e.style("font-weight") {
        let w = w.to_ascii_lowercase();
        s.bold = Some(w == "bold" || w == "bolder" || w.parse::<u32>().is_ok_and(|n| n >= 600));
    }
    if let Some(st) = e.style("font-style") {
        s.italic = matches!(st.to_ascii_lowercase().as_str(), "italic" | "oblique");
    }
    if let Some(d) = e.style("text-decoration") {
        let d = d.to_ascii_lowercase();
        s.underline |= d.contains("underline");
        s.strike |= d.contains("line-through");
    }
    if let Some(c) = e.style("color").and_then(|c| css_color(&c)) {
        s.color = Some(c);
    }
    if let Some(c) = e.style("background-color").and_then(|c| css_color(&c)) {
        s.background = Some(c);
    }
    if let Some(v) = e.style("font-size").and_then(|v| css_length(&v)) {
        s.size = Some(v);
    }
    if let Some(f) = e.style("font-family") {
        let first = f.split(',').next().unwrap_or("").trim().trim_matches(['"', '\'']).trim();
        if !first.is_empty() {
            s.font = Some(first.replace(['"', '\\'], ""));
        }
    }
    s
}

fn write_text(s: &mut String, text: &str, style: &Style) {
    let mut closes = 0;
    let mut open = |s: &mut String, call: &str| {
        s.push('#');
        s.push_str(call);
        s.push('[');
        closes += 1;
    };
    if let Some(url) = &style.link {
        open(s, &format!("link({})", string_literal(url)));
    }
    if let Some(bg) = &style.background {
        open(s, &format!("highlight(fill: {bg})"));
    }
    let mut args = Vec::new();
    if let Some(b) = style.bold {
        args.push(format!("weight: \"{}\"", if b { "bold" } else { "regular" }));
    }
    if style.italic {
        args.push("style: \"italic\"".into());
    }
    match (&style.color, &style.link) {
        (Some(c), _) => args.push(format!("fill: {c}")),
        (None, Some(_)) => args.push("fill: rgb(\"#0645ad\")".into()),
        _ => {}
    }
    if let Some(size) = &style.size {
        args.push(format!("size: {size}"));
    }
    if let Some(font) = &style.font {
        args.push(format!("font: (\"{font}\", ..body-fonts)"));
    }
    if !args.is_empty() {
        open(s, &format!("text({})", args.join(", ")));
    }
    if style.underline || style.link.is_some() {
        open(s, "underline");
    }
    if style.strike {
        open(s, "strike");
    }
    if style.sup {
        open(s, "super");
    } else if style.sub {
        open(s, "sub");
    }
    s.push('#');
    s.push_str(&string_literal(text));
    for _ in 0..closes {
        s.push(']');
    }
}

/// A Typst string literal.
fn string_literal(text: &str) -> String {
    let mut o = String::with_capacity(text.len() + 2);
    o.push('"');
    for c in text.chars() {
        match c {
            '\\' => o.push_str("\\\\"),
            '"' => o.push_str("\\\""),
            '\n' => o.push_str("\\n"),
            c if c.is_control() => {}
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

/// A CSS colour as a Typst colour expression.
fn css_color(v: &str) -> Option<String> {
    let v = v.trim().to_ascii_lowercase();
    let hex = |h: &str| -> Option<String> {
        let full = match h.len() {
            3 => h.chars().flat_map(|c| [c, c]).collect(),
            6 => h.to_string(),
            _ => return None,
        };
        full.chars().all(|c| c.is_ascii_hexdigit()).then(|| format!("rgb(\"#{full}\")"))
    };
    if let Some(h) = v.strip_prefix('#') {
        return hex(h);
    }
    if let Some(inner) = v.strip_prefix("rgb(").or_else(|| v.strip_prefix("rgba(")).and_then(|r| r.strip_suffix(')')) {
        let parts: Vec<u8> = inner.split(',').take(3).filter_map(|p| p.trim().parse::<f64>().ok()).map(|n| n.clamp(0.0, 255.0) as u8).collect();
        return (parts.len() == 3).then(|| format!("rgb({}, {}, {})", parts[0], parts[1], parts[2]));
    }
    let named = match v.as_str() {
        "black" => "000000",
        "white" => "ffffff",
        "red" => "ff0000",
        "green" => "008000",
        "lime" => "00ff00",
        "blue" => "0000ff",
        "yellow" => "ffff00",
        "cyan" | "aqua" => "00ffff",
        "magenta" | "fuchsia" => "ff00ff",
        "gray" | "grey" => "808080",
        "darkgray" | "darkgrey" => "a9a9a9",
        "lightgray" | "lightgrey" => "d3d3d3",
        "orange" => "ffa500",
        "purple" => "800080",
        "navy" => "000080",
        "maroon" => "800000",
        "olive" => "808000",
        "teal" => "008080",
        "silver" => "c0c0c0",
        _ => return None,
    };
    hex(named)
}

/// A CSS length as a Typst length (pt, px, em, %).
fn css_length(v: &str) -> Option<String> {
    let v = v.trim().to_ascii_lowercase();
    let num = |s: &str| s.trim().parse::<f64>().ok().filter(|n| n.is_finite());
    if let Some(n) = v.strip_suffix("pt").and_then(num) {
        Some(format!("{n:.2}pt"))
    } else if let Some(n) = v.strip_suffix("px").and_then(num) {
        Some(format!("{:.2}pt", n * 0.75))
    } else if let Some(n) = v.strip_suffix("em").and_then(num) {
        Some(format!("{n:.3}em"))
    } else if let Some(n) = v.strip_suffix('%').and_then(num) {
        Some(format!("{:.3}em", n / 100.0))
    } else if let Some(n) = v.strip_suffix("in").and_then(num) {
        Some(format!("{n:.3}in"))
    } else if let Some(n) = v.strip_suffix("cm").and_then(num) {
        Some(format!("{n:.3}cm"))
    } else if let Some(n) = v.strip_suffix("mm").and_then(num) {
        Some(format!("{n:.2}mm"))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text_of(html: &str) -> String {
        layer_text(&html_text_layer(html).unwrap())
    }

    #[test]
    fn english_comes_through_exactly() {
        let t = text_of("<h1>A heading</h1><p>Office <strong>bold</strong> and <em>fifty</em> “quotes”, a café.</p>");
        assert_eq!(t, "A heading\nOffice bold and fifty “quotes”, a café.");
    }

    #[test]
    fn arabic_comes_through_in_reading_order() {
        let ar = "ملفُّ المقاتلين الأجانب من جديد، قبل أيامٍ من انتهاء تشرين الأول (أكتوبر) الفائت";
        let t = text_of(&format!("<p>{ar}</p>"));
        assert_eq!(t.replace('\n', " "), ar);
    }

    #[test]
    fn mixed_directions_and_scripts() {
        let lines = [
            "זהו משפט בעברית עם מספר 2026 באמצע.",
            "يعني أنا كنت في الجامعة سنة 2019 مع Mia وبعدين رجعت.",
            "यह हिंदी में एक वाक्य है, जिसमें संयुक्ताक्षर क्ष और त्र हैं।",
            "这是一个中文句子，用来测试。",
            "این یک جملهٔ فارسی است که حروف ی و ک را دارد.",
        ];
        let html: String = lines.iter().map(|l| format!("<p>{l}</p>")).collect();
        assert_eq!(text_of(&html), lines.join("\n"));
    }

    #[test]
    fn lists_tables_and_breaks() {
        let t = text_of(
            "<ul><li>one</li><li><p>two</p><ol><li>nested</li></ol></li></ul>\
             <table><tr><th>Name</th><th>Age</th></tr><tr><td>Mia</td><td>21</td></tr></table>\
             <p>line<br>break</p>",
        );
        assert_eq!(t, "• one\n• two\n1. nested\nName\nAge\nMia\n21\nline\nbreak");
    }

    #[test]
    fn markup_characters_are_text() {
        let t = text_of("<p>#set page(width: 1pt) [x] *y* _z_ $m$ = - + / // \\ \" @ref &lt;tag&gt;</p>");
        assert_eq!(t, "#set page(width: 1pt) [x] *y* _z_ $m$ = - + / // \\ \" @ref <tag>");
    }

    #[test]
    fn writes_a_pdf_with_the_layer_attached() {
        let pdf = html_to_pdf("<p>مرحبا بالعالم</p>").unwrap();
        assert!(pdf.starts_with(b"%PDF"));
        assert!(pdf.windows(TEXT_LAYER_NAME.len()).any(|w| w == TEXT_LAYER_NAME.as_bytes()));
    }
}
