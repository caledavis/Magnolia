//! Developer tool: run one import converter on a file and print the result.
//! `convert_tool <file>` — docx/rtf/odt → HTML, xlsx → CSV, tif/heic → PNG
//! dimensions, audio/video → metadata.

use magnolia_core::convert::{docx, image, media, odt, rtf, xlsx};

fn main() {
    let path = std::env::args().nth(1).expect("usage: convert_tool <file>");
    let bytes = std::fs::read(&path).unwrap();
    let ext = magnolia_core::util::ext_of(&path);
    match ext.as_str() {
        "docx" => println!("{}", docx::docx_to_html(&bytes).unwrap()),
        "rtf" => println!("{}", rtf::rtf_to_html(&bytes).unwrap()),
        "odt" => println!("{}", odt::odt_to_html(&bytes).unwrap()),
        "xlsx" => println!("{}", xlsx::xlsx_to_csv(&bytes).unwrap()),
        "tif" | "tiff" | "heic" | "heif" => {
            let png = if ext.starts_with("ti") {
                image::tiff_to_png(&bytes)
            } else {
                image::heic_to_png(&bytes)
            }
            .unwrap();
            let img = ::image::load_from_memory(&png).unwrap();
            println!("png {}x{} ({} bytes)", img.width(), img.height(), png.len());
        }
        "mp4" | "mov" | "avi" => println!("video duration {:?}", media::video_duration(&bytes)),
        _ => {
            let m = media::audio_metadata(&bytes).expect("unreadable audio");
            println!(
                "audio duration {} channels {} rate {}",
                m.duration, m.channels, m.sample_rate
            );
        }
    }
}
