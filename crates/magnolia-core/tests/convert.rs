//! Import converters: DOCX / RTF / ODT → HTML, media metadata.

mod common;
use common::*;
use magnolia_core::convert::{docx, media, odt, rtf};

const W: &str = r#"xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships""#;

fn para(text: &str, ppr: &str) -> String {
    format!(r#"<w:p><w:pPr>{ppr}</w:pPr><w:r><w:t xml:space="preserve">{text}</w:t></w:r></w:p>"#)
}

fn num(id: u32, lvl: u32) -> String {
    format!(r#"<w:numPr><w:ilvl w:val="{lvl}"/><w:numId w:val="{id}"/></w:numPr>"#)
}

fn cell(text: &str, pr: &str) -> String {
    format!("<w:tc><w:tcPr>{pr}</w:tcPr>{}</w:tc>", para(text, ""))
}

fn sample_docx() -> Vec<u8> {
    let body = [
        para("Über die Studie", r#"<w:pStyle w:val="Berschrift1"/>"#),
        r#"<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Bold</w:t></w:r><w:r><w:rPr><w:b w:val="0"/><w:i/></w:rPr><w:t>italic</w:t></w:r><w:r><w:footnoteReference w:id="2"/></w:r><w:hyperlink r:id="rId9"><w:r><w:t>link</w:t></w:r></w:hyperlink></w:p>"#.to_string(),
        "<w:p/>".into(),
        para("Bullet A", &num(1, 0)),
        para("Nested", &num(1, 1)),
        para("Bullet B", &num(1, 0)),
        para("Step 1", &num(2, 0)),
        format!(
            "<w:tbl><w:tr>{}{}</w:tr><w:tr>{}{}{}</w:tr></w:tbl>",
            cell("A1", r#"<w:vMerge w:val="restart"/>"#),
            cell("B1", r#"<w:gridSpan w:val="2"/>"#),
            cell("", "<w:vMerge/>"),
            cell("B2", ""),
            cell("C2", "")
        ),
        r#"<w:p><w:del><w:r><w:delText>deleted</w:delText></w:r></w:del><w:ins><w:r><w:t>inserted</w:t></w:r></w:ins></w:p>"#.into(),
    ]
    .concat();
    let numbering = format!(
        r#"<w:numbering {W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>"#
    );
    let d = temp();
    let path = p(&d, "w.docx");
    make_zip(
        &path,
        &[
            ("word/document.xml", format!("<w:document {W}><w:body>{body}</w:body></w:document>").as_bytes()),
            ("word/styles.xml", format!(r#"<w:styles {W}><w:style w:styleId="Berschrift1"><w:name w:val="heading 1"/></w:style></w:styles>"#).as_bytes()),
            ("word/numbering.xml", numbering.as_bytes()),
            ("word/footnotes.xml", format!(r#"<w:footnotes {W}><w:footnote w:id="2">{}</w:footnote></w:footnotes>"#, para("The footnote.", "")).as_bytes()),
            ("word/_rels/document.xml.rels", br#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="hyperlink" Target="https://example.org" TargetMode="External"/></Relationships>"#),
        ],
    );
    std::fs::read(path).unwrap()
}

#[test]
fn docx_headings_formatting_links_and_footnotes() {
    let html = docx::docx_to_html(&sample_docx()).unwrap();
    assert!(html.starts_with("<h1>Über die Studie</h1>"), "{html}");
    assert!(html.contains("<strong>Bold</strong><em>italic</em>"));
    assert!(html.contains(r#"<a href="https://example.org">link</a>"#));
    assert!(html.contains(r#"<li id="footnote-fn-2"><p>The footnote.</p></li>"#));
    assert!(html.contains("inserted") && !html.contains("deleted"));
}

#[test]
fn docx_lists_nest_and_number() {
    let html = docx::docx_to_html(&sample_docx()).unwrap();
    assert!(html.contains("<ul><li>Bullet A<ul><li>Nested</li></ul></li><li>Bullet B</li></ul><ol><li>Step 1</li></ol>"), "{html}");
}

#[test]
fn docx_tables_keep_merged_cells() {
    let html = docx::docx_to_html(&sample_docx()).unwrap();
    assert!(html.contains(r#"<td rowspan="2"><p>A1</p></td><td colspan="2"><p>B1</p></td></tr><tr><td><p>B2</p></td>"#), "{html}");
}

#[test]
fn rtf_formatting_unicode_and_code_pages() {
    let src = br"{\rtf1\ansi\ansicpg1252{\fonttbl{\f0 Helvetica;}}{\colortbl;\red255\green0\blue0;}
\f0\fs24 Plain {\b bold} {\i italic} {\cf1 red} caf\'e9 \u8220?q\u8221? \u26085?\par
\qc Centred\par}";
    let html = rtf::rtf_to_html(src).unwrap();
    assert!(html.contains("<strong>"), "{html}");
    assert!(html.contains("color:#ff0000"));
    assert!(html.contains("café"));
    assert!(html.contains("“q”"));
    assert!(html.contains('日'));
    assert!(html.contains(r#"<p style="text-align:center">"#));
    assert!(
        !html.contains("Helvetica;"),
        "font table leaked into body: {html}"
    );
}

#[test]
fn rtf_tables_and_skipped_destinations() {
    let src = br"{\rtf1\ansi{\header Page header}{\*\generator Word;}\trowd\cellx1000\cellx2000\intbl A\cell B\cell\row\pard After\par}";
    let html = rtf::rtf_to_html(src).unwrap();
    assert!(html.contains("<table><tr><td>"), "{html}");
    assert!(html.contains("A") && html.contains("After"));
    assert!(!html.contains("Page header") && !html.contains("Word"));
}

#[test]
fn rtf_rejects_non_rtf() {
    assert!(rtf::rtf_to_html(b"hello").is_err());
}

#[test]
fn odt_styles_lists_and_tables() {
    let content = br#"<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0">
<office:automatic-styles><style:style style:name="B" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style></office:automatic-styles>
<office:body><office:text><text:h text:outline-level="2">Title</text:h><text:p>Hello <text:span text:style-name="B">bold</text:span><text:s text:c="2"/>x</text:p>
<text:list><text:list-item><text:p>One</text:p></text:list-item></text:list>
<table:table><table:table-row><table:table-cell><text:p>C</text:p></table:table-cell></table:table-row></table:table></office:text></office:body></office:document-content>"#;
    let d = temp();
    let path = p(&d, "d.odt");
    make_zip(&path, &[("content.xml", content)]);
    let html = odt::odt_to_html(&std::fs::read(path).unwrap()).unwrap();
    assert!(html.contains("<h2>Title</h2>"), "{html}");
    assert!(html.contains(r#"<span style="font-weight:bold">bold</span>&nbsp;&nbsp;x"#));
    assert!(html.contains("<ul><li><p>One</p></li></ul>"));
    assert!(html.contains("<table><tr><td><p>C</p></td></tr></table>"));
}

#[test]
fn mp4_duration_from_mvhd() {
    // ftyp + moov{mvhd v0: timescale 1000, duration 2500}
    let mut mvhd = vec![0u8; 100];
    mvhd[12..16].copy_from_slice(&1000u32.to_be_bytes());
    mvhd[16..20].copy_from_slice(&2500u32.to_be_bytes());
    let boxed = |kind: &[u8], body: &[u8]| {
        [&((body.len() + 8) as u32).to_be_bytes()[..], kind, body].concat()
    };
    let file = [
        boxed(b"ftyp", b"isom0000"),
        boxed(b"moov", &boxed(b"mvhd", &mvhd)),
    ]
    .concat();
    assert_eq!(media::video_duration(&file), Some(2.5));
    assert_eq!(media::video_duration(b"RIFF....AVI "), None);
}
