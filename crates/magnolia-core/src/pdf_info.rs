//! PDF page dimensions, computed the way pdf.js reports
//! `page.getViewport({ scale: 1 })`: the CropBox clipped to the MediaBox
//! (both inheritable from the page tree), with width/height swapped for
//! pages rotated by 90° or 270°.
//!
//! Text extraction deliberately does NOT live here. Magnolia's character
//! offsets are defined by pdf.js's text content, which the renderer's PDF
//! viewer also uses, so extraction runs in the webview with that same
//! library — any other extractor would drift and misplace codings.

use lopdf::{Document, Object, ObjectId};
use serde_json::{Value, json};

fn inherited<'a>(doc: &'a Document, mut id: ObjectId, key: &[u8]) -> Option<&'a Object> {
    for _ in 0..64 {
        let dict = doc.get_dictionary(id).ok()?;
        if let Ok(v) = dict.get(key) {
            return Some(v);
        }
        id = dict.get(b"Parent").ok()?.as_reference().ok()?;
    }
    None
}

fn as_rect(doc: &Document, obj: &Object) -> Option<[f64; 4]> {
    let obj = match obj {
        Object::Reference(r) => doc.get_object(*r).ok()?,
        o => o,
    };
    let arr = obj.as_array().ok()?;
    if arr.len() != 4 {
        return None;
    }
    let mut out = [0.0; 4];
    for (i, v) in arr.iter().enumerate() {
        let v = match v {
            Object::Reference(r) => doc.get_object(*r).ok()?,
            o => o,
        };
        out[i] = match v {
            Object::Integer(n) => *n as f64,
            Object::Real(f) => *f as f64,
            _ => return None,
        };
    }
    // Normalise so [x0, y0, x1, y1] has x0 <= x1, y0 <= y1.
    Some([
        out[0].min(out[2]),
        out[1].min(out[3]),
        out[0].max(out[2]),
        out[1].max(out[3]),
    ])
}

/// Page sizes 1-indexed (index 0 is a `{0,0}` dummy), matching the shape the
/// reader and writer exchange as `pdfPageSizes`.
pub fn page_sizes(bytes: &[u8]) -> Result<Vec<Value>, String> {
    let doc = Document::load_mem(bytes).map_err(|e| e.to_string())?;
    let mut out = vec![json!({ "width": 0, "height": 0 })];
    for (_, id) in doc.get_pages() {
        let media = inherited(&doc, id, b"MediaBox")
            .and_then(|o| as_rect(&doc, o))
            .unwrap_or([0.0, 0.0, 612.0, 792.0]);
        let crop = inherited(&doc, id, b"CropBox").and_then(|o| as_rect(&doc, o));
        let view = match crop {
            Some(c) => {
                let r = [
                    c[0].max(media[0]),
                    c[1].max(media[1]),
                    c[2].min(media[2]),
                    c[3].min(media[3]),
                ];
                if r[2] > r[0] && r[3] > r[1] { r } else { media }
            }
            None => media,
        };
        let rotate = inherited(&doc, id, b"Rotate")
            .and_then(|o| o.as_i64().ok())
            .unwrap_or(0);
        let (mut w, mut h) = (view[2] - view[0], view[3] - view[1]);
        if rotate.rem_euclid(180) == 90 {
            std::mem::swap(&mut w, &mut h);
        }
        out.push(json!({ "width": crate::util::num(w), "height": crate::util::num(h) }));
    }
    Ok(out)
}
