//! RTF → HTML.
//!
//! A small RTF reader covering what documents sent for qualitative analysis
//! use: paragraphs and alignment, bold / italic / underline / strike /
//! super- and subscript, font family / size / colour / highlight, tables,
//! embedded PNG and JPEG pictures, and text in any ANSI code page or
//! `\u` Unicode escape. Headers, footers, footnotes, field instructions and
//! other metadata destinations are skipped; their text isn't body text.

use super::html::{data_uri, escape};
use std::collections::HashMap;

#[derive(Clone, Default)]
struct CharFmt {
    bold: bool,
    italic: bool,
    underline: bool,
    strike: bool,
    sup: bool,
    sub: bool,
    color: usize,
    highlight: usize,
    font: Option<i32>,
    size_half_pts: Option<i32>,
}

#[derive(Clone)]
struct GroupState {
    fmt: CharFmt,
    /// Ignore all text in this group (metadata destination).
    skip: bool,
    /// Unicode fallback character count (`\ucN`).
    uc: usize,
    dest: Dest,
}

#[derive(Clone, Copy, PartialEq)]
enum Dest {
    Body,
    FontTable,
    ColorTable,
    Picture,
}

#[derive(Default)]
struct Para {
    html: String,
}

struct Rtf<'a> {
    src: &'a [u8],
    pos: usize,
    stack: Vec<GroupState>,
    state: GroupState,
    default_codepage: u16,
    fonts: HashMap<i32, (String, Option<u16>)>,
    font_being_defined: Option<i32>,
    font_name: String,
    colors: Vec<Option<String>>,
    color_parts: (u8, u8, u8, bool),
    pict: (Vec<u8>, Option<&'static str>, Option<u8>),
    /// Bytes from `\'hh` escapes awaiting decoding as a unit (multi-byte
    /// code pages split one character across escapes).
    pending: Vec<u8>,
    pending_skip: usize,
    text: String,
    text_fmt: CharFmt,
    para: Para,
    para_align: Option<&'static str>,
    in_table: bool,
    out: String,
    row: Vec<String>,
    cell: String,
    table: Vec<Vec<String>>,
    high_surrogate: Option<u16>,
}

fn codepage_for_charset(charset: i32) -> Option<u16> {
    Some(match charset {
        128 => 932,
        129 => 949,
        134 => 936,
        136 => 950,
        161 => 1253,
        162 => 1254,
        163 => 1258,
        177 => 1255,
        178 => 1256,
        186 => 1257,
        204 => 1251,
        222 => 874,
        238 => 1250,
        _ => return None,
    })
}

fn decode_codepage(bytes: &[u8], cp: u16) -> String {
    let enc = match cp {
        874 => encoding_rs::WINDOWS_874,
        932 => encoding_rs::SHIFT_JIS,
        936 => encoding_rs::GBK,
        949 => encoding_rs::EUC_KR,
        950 => encoding_rs::BIG5,
        1250 => encoding_rs::WINDOWS_1250,
        1251 => encoding_rs::WINDOWS_1251,
        1253 => encoding_rs::WINDOWS_1253,
        1254 => encoding_rs::WINDOWS_1254,
        1255 => encoding_rs::WINDOWS_1255,
        1256 => encoding_rs::WINDOWS_1256,
        1257 => encoding_rs::WINDOWS_1257,
        1258 => encoding_rs::WINDOWS_1258,
        10000 => encoding_rs::MACINTOSH,
        _ => encoding_rs::WINDOWS_1252,
    };
    enc.decode_without_bom_handling(bytes).0.into_owned()
}

/// Destinations whose content is never body text.
const SKIP_DESTINATIONS: &[&str] = &[
    "stylesheet",
    "info",
    "header",
    "headerl",
    "headerr",
    "headerf",
    "footer",
    "footerl",
    "footerr",
    "footerf",
    "footnote",
    "fldinst",
    "object",
    "xe",
    "tc",
    "filetbl",
    "revtbl",
    "listtable",
    "listoverridetable",
    "rsidtbl",
    "generator",
    "nonshppict",
    "themedata",
    "colorschememapping",
    "latentstyles",
    "datastore",
    "pgdsctbl",
    "annotation",
    "atnid",
    "atnauthor",
];

impl<'a> Rtf<'a> {
    fn new(src: &'a [u8]) -> Self {
        let state = GroupState {
            fmt: CharFmt::default(),
            skip: false,
            uc: 1,
            dest: Dest::Body,
        };
        Rtf {
            src,
            pos: 0,
            stack: vec![],
            state,
            default_codepage: 1252,
            fonts: HashMap::new(),
            font_being_defined: None,
            font_name: String::new(),
            colors: vec![],
            color_parts: (0, 0, 0, false),
            pict: (vec![], None, None),
            pending: vec![],
            pending_skip: 0,
            text: String::new(),
            text_fmt: CharFmt::default(),
            para: Para::default(),
            para_align: None,
            in_table: false,
            out: String::new(),
            row: vec![],
            cell: String::new(),
            table: vec![],
            high_surrogate: None,
        }
    }

    fn codepage(&self) -> u16 {
        self.state
            .fmt
            .font
            .and_then(|f| self.fonts.get(&f))
            .and_then(|(_, cp)| *cp)
            .unwrap_or(self.default_codepage)
    }

    fn flush_pending(&mut self) {
        if !self.pending.is_empty() {
            let s = decode_codepage(&std::mem::take(&mut self.pending), self.codepage());
            self.push_str(&s);
        }
    }

    fn push_str(&mut self, s: &str) {
        match self.state.dest {
            Dest::FontTable => self.font_name.push_str(s),
            Dest::Body if !self.state.skip => {
                if !fmt_eq(&self.text_fmt, &self.state.fmt) {
                    self.flush_run();
                    self.text_fmt = self.state.fmt.clone();
                }
                self.text.push_str(s);
            }
            _ => {}
        }
    }

    fn flush_run(&mut self) {
        if self.text.is_empty() {
            return;
        }
        let text = std::mem::take(&mut self.text);
        let mut html = escape(&text)
            .replace('\t', "&nbsp;&nbsp;&nbsp;&nbsp;")
            .replace('\n', "<br>");
        let f = &self.text_fmt;
        let mut css = Vec::new();
        if let Some(Some(c)) = self.colors.get(f.color).filter(|_| f.color > 0) {
            css.push(format!("color:{c}"));
        }
        if let Some(Some(c)) = self.colors.get(f.highlight).filter(|_| f.highlight > 0) {
            css.push(format!("background-color:{c}"));
        }
        if let Some(sz) = f.size_half_pts.filter(|s| *s > 0) {
            css.push(format!("font-size:{}pt", sz as f64 / 2.0));
        }
        if let Some((name, _)) = f
            .font
            .and_then(|i| self.fonts.get(&i))
            .filter(|(n, _)| !n.is_empty())
        {
            css.push(format!("font-family:'{}'", name.replace(['\'', '"'], "")));
        }
        if !css.is_empty() {
            html = format!("<span style=\"{}\">{html}</span>", css.join(";"));
        }
        for (on, tag) in [
            (f.sup, "sup"),
            (f.sub, "sub"),
            (f.strike, "s"),
            (f.underline, "u"),
            (f.italic, "em"),
            (f.bold, "strong"),
        ] {
            if on {
                html = format!("<{tag}>{html}</{tag}>");
            }
        }
        self.para.html.push_str(&html);
    }

    fn end_paragraph(&mut self) {
        self.flush_pending();
        self.flush_run();
        let para = std::mem::take(&mut self.para);
        let inner = if para.html.is_empty() {
            "&nbsp;".to_string()
        } else {
            para.html
        };
        let style = self
            .para_align
            .map(|a| format!(" style=\"text-align:{a}\""))
            .unwrap_or_default();
        let p = format!("<p{style}>{inner}</p>");
        if self.in_table {
            self.cell.push_str(&p);
        } else {
            self.close_table();
            self.out.push_str(&p);
        }
    }

    fn end_cell(&mut self) {
        self.flush_pending();
        self.flush_run();
        if !self.para.html.is_empty() {
            let para = std::mem::take(&mut self.para);
            self.cell.push_str(&para.html);
        }
        self.row.push(std::mem::take(&mut self.cell));
    }

    fn end_row(&mut self) {
        if !self.cell.is_empty() || !self.para.html.is_empty() {
            self.end_cell();
        }
        let row = std::mem::take(&mut self.row);
        if !row.is_empty() {
            self.table.push(row);
        }
        self.in_table = false;
    }

    fn close_table(&mut self) {
        if self.table.is_empty() {
            return;
        }
        self.out.push_str("<table>");
        for row in std::mem::take(&mut self.table) {
            self.out.push_str("<tr>");
            for c in row {
                self.out.push_str(&format!(
                    "<td>{}</td>",
                    if c.is_empty() { "&nbsp;".into() } else { c }
                ));
            }
            self.out.push_str("</tr>");
        }
        self.out.push_str("</table>");
    }

    fn push_char(&mut self, c: char) {
        self.flush_pending();
        let mut b = [0u8; 4];
        self.push_str(c.encode_utf8(&mut b));
    }

    fn run(&mut self) {
        while self.pos < self.src.len() {
            let c = self.src[self.pos];
            match c {
                b'{' => {
                    self.flush_pending();
                    self.pos += 1;
                    self.stack.push(self.state.clone());
                }
                b'}' => {
                    self.flush_pending();
                    self.pos += 1;
                    self.end_group();
                    if let Some(s) = self.stack.pop() {
                        self.state = s;
                    }
                }
                b'\\' => self.control(),
                b'\r' | b'\n' => self.pos += 1,
                _ => {
                    self.pos += 1;
                    if self.pending_skip > 0 {
                        self.pending_skip -= 1;
                        continue;
                    }
                    match self.state.dest {
                        Dest::Picture => {
                            if c.is_ascii_hexdigit() {
                                let v = (c as char).to_digit(16).unwrap() as u8;
                                match self.pict.2.take() {
                                    Some(hi) => self.pict.0.push(hi << 4 | v),
                                    None => self.pict.2 = Some(v),
                                }
                            }
                        }
                        Dest::ColorTable if c == b';' => {
                            let (r, g, b, set) = self.color_parts;
                            self.colors
                                .push(set.then(|| format!("#{r:02x}{g:02x}{b:02x}")));
                            self.color_parts = (0, 0, 0, false);
                        }
                        Dest::FontTable if c == b';' => self.finish_font(),
                        _ if c < 0x80 => self.push_char(c as char),
                        // Raw 8-bit text: decode in the current code page.
                        _ => self.pending.push(c),
                    }
                }
            }
        }
        self.flush_pending();
        if !self.para.html.is_empty() || !self.text.is_empty() {
            self.end_paragraph();
        }
        if !self.row.is_empty() || !self.cell.is_empty() {
            self.end_row();
        }
        self.close_table();
    }

    fn finish_font(&mut self) {
        if let Some(id) = self.font_being_defined.take() {
            let name = std::mem::take(&mut self.font_name).trim().to_string();
            let cp = self.fonts.get(&id).and_then(|(_, cp)| *cp);
            self.fonts.insert(id, (name, cp));
        }
    }

    fn end_group(&mut self) {
        match self.state.dest {
            Dest::Picture if !self.stack.last().is_some_and(|s| s.dest == Dest::Picture) => {
                let (bytes, mime, _) = std::mem::take(&mut self.pict);
                if let (Some(mime), false) = (mime, bytes.is_empty()) {
                    let parent_skip = self.stack.last().is_some_and(|s| s.skip);
                    if !parent_skip {
                        self.flush_run();
                        self.para
                            .html
                            .push_str(&format!("<img src=\"{}\" />", data_uri(mime, &bytes)));
                    }
                }
            }
            Dest::FontTable if self.font_being_defined.is_some() => self.finish_font(),
            _ => {}
        }
    }

    fn control(&mut self) {
        self.pos += 1;
        let Some(&c) = self.src.get(self.pos) else {
            return;
        };
        if !c.is_ascii_alphabetic() {
            self.pos += 1;
            match c {
                b'\'' => {
                    let hex =
                        std::str::from_utf8(self.src.get(self.pos..self.pos + 2).unwrap_or(b""))
                            .unwrap_or("");
                    self.pos += 2;
                    if self.pending_skip > 0 {
                        self.pending_skip -= 1;
                        return;
                    }
                    if let Ok(b) = u8::from_str_radix(hex, 16) {
                        match self.state.dest {
                            Dest::Body | Dest::FontTable => self.pending.push(b),
                            _ => {}
                        }
                    }
                }
                b'*' => {
                    // `{\*\dest …}`: an optional destination we don't know →
                    // skip it, except the modern picture wrapper.
                    if !self.src[self.pos..].starts_with(b"\\shppict") {
                        self.state.skip = true;
                    }
                }
                b'~' => self.push_char('\u{00A0}'),
                b'-' => {}
                b'_' => self.push_char('\u{2011}'),
                b'\r' | b'\n' => self.paragraph_break(),
                b'\\' | b'{' | b'}' => self.push_char(c as char),
                _ => {}
            }
            return;
        }
        let start = self.pos;
        while self.pos < self.src.len() && self.src[self.pos].is_ascii_alphabetic() {
            self.pos += 1;
        }
        let word = std::str::from_utf8(&self.src[start..self.pos])
            .unwrap_or("")
            .to_string();
        let num_start = self.pos;
        if self.src.get(self.pos) == Some(&b'-') {
            self.pos += 1;
        }
        while self.pos < self.src.len() && self.src[self.pos].is_ascii_digit() {
            self.pos += 1;
        }
        let param: Option<i32> = std::str::from_utf8(&self.src[num_start..self.pos])
            .ok()
            .and_then(|s| s.parse().ok());
        if self.src.get(self.pos) == Some(&b' ') {
            self.pos += 1;
        }
        if word != "u" {
            self.flush_pending();
        }
        self.word(&word, param);
    }

    fn paragraph_break(&mut self) {
        if self.state.dest == Dest::Body && !self.state.skip {
            self.end_paragraph();
        }
    }

    fn word(&mut self, word: &str, param: Option<i32>) {
        let on = param != Some(0);
        let in_body = self.state.dest == Dest::Body && !self.state.skip;
        let f = &mut self.state.fmt;
        match word {
            "ansicpg" => self.default_codepage = param.unwrap_or(1252) as u16,
            "mac" => self.default_codepage = 10000,
            "fonttbl" => self.state.dest = Dest::FontTable,
            "colortbl" => self.state.dest = Dest::ColorTable,
            "pict" => {
                self.state.dest = Dest::Picture;
                self.pict = (vec![], None, None);
            }
            "pngblip" => self.pict.1 = Some("image/png"),
            "jpegblip" => self.pict.1 = Some("image/jpeg"),
            "bin" => {
                // Raw binary picture data of `param` bytes.
                let n = param.unwrap_or(0).max(0) as usize;
                let end = (self.pos + n).min(self.src.len());
                if self.state.dest == Dest::Picture {
                    self.pict.0.extend_from_slice(&self.src[self.pos..end]);
                }
                self.pos = end;
            }
            "red" => {
                self.color_parts = (
                    param.unwrap_or(0) as u8,
                    self.color_parts.1,
                    self.color_parts.2,
                    true,
                )
            }
            "green" => {
                self.color_parts = (
                    self.color_parts.0,
                    param.unwrap_or(0) as u8,
                    self.color_parts.2,
                    true,
                )
            }
            "blue" => {
                self.color_parts = (
                    self.color_parts.0,
                    self.color_parts.1,
                    param.unwrap_or(0) as u8,
                    true,
                )
            }
            "f" if self.state.dest == Dest::FontTable => {
                self.finish_font();
                self.font_being_defined = param;
                if let Some(id) = param {
                    self.fonts.entry(id).or_insert((String::new(), None));
                }
            }
            "fcharset" if self.state.dest == Dest::FontTable => {
                if let (Some(id), Some(cs)) = (self.font_being_defined, param) {
                    let cp = codepage_for_charset(cs);
                    self.fonts.entry(id).or_insert((String::new(), None)).1 = cp;
                }
            }
            "f" => f.font = param,
            "fs" => f.size_half_pts = param,
            "b" => f.bold = on,
            "i" => f.italic = on,
            "ul" => f.underline = on,
            "uld" | "uldb" | "ulw" | "ulwave" | "uldash" | "ulth" => f.underline = on,
            "ulnone" => f.underline = false,
            "strike" | "striked" => f.strike = on,
            "super" => (f.sup, f.sub) = (true, false),
            "sub" => (f.sup, f.sub) = (false, true),
            "nosupersub" => (f.sup, f.sub) = (false, false),
            "cf" => f.color = param.unwrap_or(0).max(0) as usize,
            "highlight" | "cb" | "chcbpat" => f.highlight = param.unwrap_or(0).max(0) as usize,
            "plain" => {
                let font = f.font;
                *f = CharFmt {
                    font,
                    ..Default::default()
                };
            }
            "uc" => self.state.uc = param.unwrap_or(1).max(0) as usize,
            "u" => {
                let mut v = param.unwrap_or(0);
                if v < 0 {
                    v += 65536;
                }
                let v = v as u32;
                if (0xD800..0xDC00).contains(&v) {
                    self.high_surrogate = Some(v as u16);
                } else if (0xDC00..0xE000).contains(&v) {
                    if let Some(hi) = self.high_surrogate.take() {
                        let cp = 0x10000 + ((hi as u32 - 0xD800) << 10) + (v - 0xDC00);
                        if let Some(ch) = char::from_u32(cp) {
                            self.push_char(ch);
                        }
                    }
                } else if let Some(ch) = char::from_u32(v) {
                    self.push_char(ch);
                }
                self.pending_skip = self.state.uc;
            }
            "par" | "sect" | "page" if in_body => self.end_paragraph(),
            "line" => self.push_char('\n'),
            "tab" => self.push_char('\t'),
            "emdash" => self.push_char('—'),
            "endash" => self.push_char('–'),
            "bullet" => self.push_char('•'),
            "lquote" => self.push_char('‘'),
            "rquote" => self.push_char('’'),
            "ldblquote" => self.push_char('“'),
            "rdblquote" => self.push_char('”'),
            "pard" => {
                self.para_align = None;
                self.in_table = false;
            }
            "qc" => self.para_align = Some("center"),
            "qr" => self.para_align = Some("right"),
            "qj" => self.para_align = Some("justify"),
            "ql" => self.para_align = None,
            "intbl" => self.in_table = true,
            "cell" if in_body => {
                self.in_table = true;
                self.end_cell();
            }
            "row" if in_body => self.end_row(),
            "trowd" => self.in_table = true,
            w if SKIP_DESTINATIONS.contains(&w) => self.state.skip = true,
            _ => {}
        }
    }
}

fn fmt_eq(a: &CharFmt, b: &CharFmt) -> bool {
    a.bold == b.bold
        && a.italic == b.italic
        && a.underline == b.underline
        && a.strike == b.strike
        && a.sup == b.sup
        && a.sub == b.sub
        && a.color == b.color
        && a.highlight == b.highlight
        && a.font == b.font
        && a.size_half_pts == b.size_half_pts
}

pub fn rtf_to_html(bytes: &[u8]) -> Result<String, String> {
    if !bytes.starts_with(b"{\\rtf") {
        return Err("Not an RTF document.".into());
    }
    let mut r = Rtf::new(bytes);
    r.run();
    Ok(r.out)
}
