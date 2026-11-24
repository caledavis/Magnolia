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
            .unwrap_or(0)
            .rem_euclid(360);
        let (mut w, mut h) = (view[2] - view[0], view[3] - view[1]);
        if rotate.rem_euclid(180) == 90 {
            std::mem::swap(&mut w, &mut h);
        }
        let n = crate::util::num;
        // Also the page's geometry, to convert a region between how it's
        // drawn and the REFI-QDA standard's PDF points (see PageGeometry).
        out.push(json!({
            "width": n(w), "height": n(h),
            "view": view.map(n), "media": media.map(n), "rotate": rotate,
        }));
    }
    Ok(out)
}

/// How a PDF page is drawn (by pdf.js at scale 1: its crop box, clipped to
/// its media box, turned by its rotation; origin top-left, y down), for
/// converting a region on it to and from the REFI-QDA standard's PDF points,
/// "starting from the bottom-left of the PDF media box" (§10.3).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PageGeometry {
    pub view: [f64; 4],
    pub media: [f64; 4],
    pub rotate: i64,
}

impl PageGeometry {
    /// From one entry of `page_sizes` (none for one without a size).
    pub fn of(size: &Value) -> Option<Self> {
        let rect = |k: &str| -> Option<[f64; 4]> {
            let a = size.get(k)?.as_array()?;
            Some([a.first()?.as_f64()?, a.get(1)?.as_f64()?, a.get(2)?.as_f64()?, a.get(3)?.as_f64()?])
        };
        let rotate = size.get("rotate").and_then(Value::as_i64).unwrap_or(0).rem_euclid(360);
        if let (Some(view), Some(media)) = (rect("view"), rect("media")) {
            return Some(Self { view, media, rotate });
        }
        // Only a size: a page whose boxes are the same, at the origin.
        let (w, h) = (size.get("width")?.as_f64()?, size.get("height")?.as_f64()?);
        (w > 0.0 && h > 0.0).then_some(Self { view: [0.0, 0.0, w, h], media: [0.0, 0.0, w, h], rotate: 0 })
    }

    /// A point as drawn → the standard's (x, y) from the media box's
    /// bottom-left.
    pub fn to_standard(&self, vx: f64, vy: f64) -> (f64, f64) {
        let [x0, y0, x1, y1] = self.view;
        let (ux, uy) = match self.rotate {
            90 => (vy + x0, vx + y0),
            180 => (x1 - vx, vy + y0),
            270 => (x1 - vy, y1 - vx),
            _ => (vx + x0, y1 - vy),
        };
        (ux - self.media[0], uy - self.media[1])
    }

    /// The standard's point → as drawn.
    pub fn from_standard(&self, sx: f64, sy: f64) -> (f64, f64) {
        let [x0, y0, x1, y1] = self.view;
        let (ux, uy) = (sx + self.media[0], sy + self.media[1]);
        match self.rotate {
            90 => (uy - y0, ux - x0),
            180 => (x1 - ux, uy - y0),
            270 => (y1 - uy, x1 - ux),
            _ => (ux - x0, y1 - uy),
        }
    }
}

#[cfg(test)]
mod geometry_tests {
    use super::PageGeometry;

    #[test]
    fn converts_both_ways_for_every_rotation() {
        for rotate in [0, 90, 180, 270] {
            let g = PageGeometry { view: [10.0, 20.0, 600.0, 800.0], media: [0.0, 5.0, 612.0, 810.0], rotate };
            for (vx, vy) in [(0.0, 0.0), (100.0, 50.0), (33.0, 444.0)] {
                let (sx, sy) = g.to_standard(vx, vy);
                let (bx, by) = g.from_standard(sx, sy);
                assert!((bx - vx).abs() < 1e-9 && (by - vy).abs() < 1e-9, "{rotate}: {vx},{vy}");
            }
        }
        // Unrotated, crop box = media box at the origin: a plain flip.
        let g = PageGeometry { view: [0.0, 0.0, 612.0, 792.0], media: [0.0, 0.0, 612.0, 792.0], rotate: 0 };
        assert_eq!(g.to_standard(72.0, 100.0), (72.0, 692.0));
        // A crop box inset from the media box moves the origin.
        let g = PageGeometry { view: [36.0, 36.0, 576.0, 756.0], media: [0.0, 0.0, 612.0, 792.0], rotate: 0 };
        assert_eq!(g.to_standard(0.0, 0.0), (36.0, 756.0));
    }
}
