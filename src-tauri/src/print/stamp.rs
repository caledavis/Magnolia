//! Page chrome for exported PDFs: the wordmark top-right and "x/y" page
//! numbers bottom-right, matching the layout of the renderer's header and
//! footer templates (`utils/pdf-export.ts`): 48px right inset, 28px from the
//! page edge, a 24px-tall logo at 70% opacity, 10px #888 page numbers.

use super::PdfOptions;
use base64::Engine;
use lopdf::{Dictionary, Document, Object, ObjectId, Stream, dictionary};

const PX: f64 = 0.75; // CSS px → PDF points
const RIGHT_INSET: f64 = 48.0 * PX;
const EDGE_INSET: f64 = 28.0 * PX;
const LOGO_HEIGHT: f64 = 24.0 * PX;
const NUMBER_SIZE: f64 = 10.0 * PX;

/// The SVG inlined in a header template's `<img src="data:image/svg+xml;base64,…">`.
pub fn svg_from_template(template: &str) -> Option<Vec<u8>> {
    let marker = "data:image/svg+xml;base64,";
    let start = template.find(marker)? + marker.len();
    let end = start + template[start..].find(['"', '\''])?;
    base64::engine::general_purpose::STANDARD
        .decode(&template[start..end])
        .ok()
}

/// Rasterise the logo to an RGB image + alpha mask; returns (w, h, rgb, alpha).
fn rasterize(svg: &[u8], target_height_px: f32) -> Option<(u32, u32, Vec<u8>, Vec<u8>)> {
    use resvg::{tiny_skia, usvg};
    let mut opt = usvg::Options::default();
    opt.fontdb_mut().load_system_fonts();
    let tree = usvg::Tree::from_data(svg, &opt).ok()?;
    let size = tree.size();
    let scale = target_height_px / size.height();
    let (w, h) = (
        (size.width() * scale).ceil() as u32,
        target_height_px.ceil() as u32,
    );
    let mut pixmap = tiny_skia::Pixmap::new(w.max(1), h.max(1))?;
    resvg::render(
        &tree,
        tiny_skia::Transform::from_scale(scale, scale),
        &mut pixmap.as_mut(),
    );
    let mut rgb = Vec::with_capacity((w * h * 3) as usize);
    let mut alpha = Vec::with_capacity((w * h) as usize);
    for p in pixmap.pixels() {
        let c = p.demultiply();
        rgb.extend_from_slice(&[c.red(), c.green(), c.blue()]);
        alpha.push(c.alpha());
    }
    Some((w, h, rgb, alpha))
}

fn compressed(dict: Dictionary, data: Vec<u8>) -> Stream {
    let mut s = Stream::new(dict, data);
    let _ = s.compress();
    s
}

/// Helvetica advance widths (per 1000 em) for the characters in "x/y".
fn helvetica_width(text: &str, size: f64) -> f64 {
    text.chars()
        .map(|c| if c == '/' { 278.0 } else { 556.0 })
        .sum::<f64>()
        * size
        / 1000.0
}

fn page_box(doc: &Document, page: ObjectId) -> (f64, f64) {
    let mut id = page;
    for _ in 0..32 {
        let Ok(dict) = doc.get_dictionary(id) else {
            break;
        };
        if let Ok(arr) = dict.get(b"MediaBox").and_then(Object::as_array) {
            let n: Vec<f64> = arr
                .iter()
                .filter_map(|o| {
                    o.as_float()
                        .ok()
                        .map(f64::from)
                        .or_else(|| o.as_i64().ok().map(|i| i as f64))
                })
                .collect();
            if n.len() == 4 {
                return ((n[2] - n[0]).abs(), (n[3] - n[1]).abs());
            }
        }
        match dict.get(b"Parent").and_then(Object::as_reference) {
            Ok(p) => id = p,
            Err(_) => break,
        }
    }
    (612.0, 792.0)
}

pub fn stamp(pdf: &[u8], opts: &PdfOptions) -> Result<Vec<u8>, String> {
    let mut doc = Document::load_mem(pdf).map_err(|e| e.to_string())?;
    let logo = opts
        .header_logo_svg
        .as_deref()
        .and_then(|svg| rasterize(svg, (LOGO_HEIGHT * 8.0) as f32));

    let logo_id = logo.as_ref().map(|(w, h, rgb, alpha)| {
        let mask = doc.add_object(compressed(
            dictionary! { "Type" => "XObject", "Subtype" => "Image", "Width" => *w as i64, "Height" => *h as i64,
                          "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8 },
            alpha.clone(),
        ));
        let img = doc.add_object(compressed(
            dictionary! { "Type" => "XObject", "Subtype" => "Image", "Width" => *w as i64, "Height" => *h as i64,
                          "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8, "SMask" => mask },
            rgb.clone(),
        ));
        (img, *w as f64 / *h as f64)
    });
    let gs = doc.add_object(dictionary! { "Type" => "ExtGState", "ca" => 0.7, "CA" => 0.7 });
    let font = doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica", "Encoding" => "WinAnsiEncoding" });

    let pages: Vec<ObjectId> = doc.get_pages().into_values().collect();
    let total = pages.len();
    for (i, page) in pages.into_iter().enumerate() {
        let (pw, ph) = page_box(&doc, page);
        let mut ops = String::new();
        let mut xobjects = Dictionary::new();
        if let Some((img, aspect)) = logo_id {
            let w = LOGO_HEIGHT * aspect;
            let x = pw - RIGHT_INSET - w;
            let y = ph - EDGE_INSET - LOGO_HEIGHT;
            ops.push_str(&format!(
                "q /GS gs {w:.3} 0 0 {LOGO_HEIGHT:.3} {x:.3} {y:.3} cm /Logo Do Q\n"
            ));
            xobjects.set("Logo", img);
        }
        if opts.page_numbers {
            let text = format!("{}/{}", i + 1, total);
            let x = pw - RIGHT_INSET - helvetica_width(&text, NUMBER_SIZE);
            ops.push_str(&format!(
                "q 0.533 g BT /F1 {NUMBER_SIZE:.2} Tf {x:.3} {EDGE_INSET:.3} Td ({text}) Tj ET Q\n"
            ));
        }
        let form = doc.add_object(compressed(
            dictionary! {
                "Type" => "XObject", "Subtype" => "Form",
                "BBox" => vec![0.into(), 0.into(), pw.into(), ph.into()],
                "Resources" => dictionary! {
                    "XObject" => xobjects,
                    "ExtGState" => dictionary! { "GS" => gs },
                    "Font" => dictionary! { "F1" => font },
                },
            },
            ops.into_bytes(),
        ));
        doc.add_xobject(page, "MagnoliaChrome", form)
            .map_err(|e| e.to_string())?;

        // Wrap the existing content in q…Q so any graphics state it leaves
        // behind can't move or clip the chrome.
        let open = doc.add_object(Stream::new(Dictionary::new(), b"q\n".to_vec()));
        let close = doc.add_object(Stream::new(
            Dictionary::new(),
            b"\nQ q /MagnoliaChrome Do Q\n".to_vec(),
        ));
        let page_dict = doc
            .get_object_mut(page)
            .and_then(Object::as_dict_mut)
            .map_err(|e| e.to_string())?;
        let mut contents: Vec<Object> = match page_dict.get(b"Contents") {
            Ok(Object::Array(a)) => a.clone(),
            Ok(o) => vec![o.clone()],
            Err(_) => vec![],
        };
        contents.insert(0, open.into());
        contents.push(close.into());
        page_dict.set("Contents", contents);
    }
    let mut out = Vec::new();
    doc.save_to(&mut out).map_err(|e| e.to_string())?;
    Ok(out)
}
