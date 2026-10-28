//! TIFF / HEIC → PNG at import time. The webview can't display either
//! everywhere (WebKit shows HEIC, WebView2 doesn't; nobody shows TIFF), so
//! they're normalised at the boundary and the rest of the app only ever sees
//! a PNG. Multi-image files keep their primary/first image — for QDA that's
//! the scanned page or photo the user means to code.

use image::{ImageFormat, RgbaImage};
use std::io::Cursor;

fn encode_png(img: RgbaImage) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    img.write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

pub fn tiff_to_png(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let img = image::load_from_memory_with_format(bytes, ImageFormat::Tiff)
        .map_err(|e| format!("Could not decode TIFF: {e}"))?;
    encode_png(img.to_rgba8())
}

pub fn heic_to_png(bytes: &[u8]) -> Result<Vec<u8>, String> {
    use zune_heic::HeifDecoder;
    use zune_heic::zune_core::bytestream::ZCursor;
    use zune_heic::zune_core::colorspace::ColorSpace;
    let mut dec = HeifDecoder::new(ZCursor::new(bytes));
    let pixels = dec
        .decode()
        .map_err(|e| format!("Could not decode HEIC: {e:?}"))?;
    let (w, h) = (
        dec.width().unwrap_or(0) as u32,
        dec.height().unwrap_or(0) as u32,
    );
    let rgba: Vec<u8> = match dec.colorspace() {
        Some(ColorSpace::RGBA) => pixels,
        Some(ColorSpace::RGB) => pixels
            .as_chunks::<3>()
            .0
            .iter()
            .flat_map(|p| [p[0], p[1], p[2], 255])
            .collect(),
        Some(ColorSpace::Luma) => pixels.iter().flat_map(|&l| [l, l, l, 255]).collect(),
        Some(ColorSpace::LumaA) => pixels
            .as_chunks::<2>()
            .0
            .iter()
            .flat_map(|p| [p[0], p[0], p[0], p[1]])
            .collect(),
        other => return Err(format!("Unsupported HEIC colour space {other:?}")),
    };
    let img = RgbaImage::from_raw(w, h, rgba).ok_or("HEIC decoder returned a malformed image")?;
    encode_png(img)
}
