//! HTML → PDF with the platform webview.
//!
//! The HTML is served to a hidden window through the `magnolia-print://`
//! protocol (data: URLs cap out at a few MB, and exports embed base64
//! thumbnails), printed to a temp file by the native engine, and then —
//! because only Chromium understands Electron-style header/footer templates
//! — Magnolia's wordmark and "x/y" page numbers are stamped onto each page.

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
mod stamp;
#[cfg(target_os = "windows")]
mod windows;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, mpsc};
use std::time::Duration;
use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};

pub const SCHEME: &str = "magnolia-print";
pub const LABEL_PREFIX: &str = "print-";

static PAGES: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);
static NEXT: AtomicU64 = AtomicU64::new(1);

/// Page geometry and chrome, in inches.
#[derive(Clone)]
pub struct PdfOptions {
    pub page_width: f64,
    pub page_height: f64,
    pub margin_top: f64,
    pub margin_bottom: f64,
    pub margin_left: f64,
    pub margin_right: f64,
    /// SVG to place top-right on every page (from the header template).
    pub header_logo_svg: Option<Vec<u8>>,
    /// Stamp "x/y" bottom-right (the footer template asked for page numbers).
    pub page_numbers: bool,
}

fn paper(name: &str) -> (f64, f64) {
    match name {
        "A3" => (11.69, 16.54),
        "A5" => (5.83, 8.27),
        "Letter" => (8.5, 11.0),
        "Legal" => (8.5, 14.0),
        "Tabloid" => (11.0, 17.0),
        _ => (8.27, 11.69),
    }
}

impl PdfOptions {
    /// Office documents converted on import.
    pub fn import() -> Self {
        let (w, h) = paper("Letter");
        PdfOptions {
            page_width: w,
            page_height: h,
            margin_top: 0.4,
            margin_bottom: 0.4,
            margin_left: 0.4,
            margin_right: 0.4,
            header_logo_svg: None,
            page_numbers: false,
        }
    }

    /// App exports. With a header/footer the margin doubles as its canvas.
    pub fn export(paper_size: &str, header: Option<&str>, footer: Option<&str>) -> Self {
        let (w, h) = paper(paper_size);
        let header_logo_svg = header.and_then(stamp::svg_from_template);
        let page_numbers = footer.is_some_and(|f| f.contains("pageNumber"));
        PdfOptions {
            page_width: w,
            page_height: h,
            margin_top: if header.is_some_and(|h| !h.is_empty()) {
                0.95
            } else {
                0.5
            },
            margin_bottom: if footer.is_some_and(|f| !f.is_empty()) {
                0.95
            } else {
                0.5
            },
            margin_left: 0.5,
            margin_right: 0.5,
            header_logo_svg,
            page_numbers,
        }
    }
}

/// Serve a registered print page.
pub fn serve(path: &str) -> Option<String> {
    let id = path.trim_start_matches('/');
    PAGES.lock().unwrap().as_ref()?.get(id).cloned()
}

fn page_url(id: &str) -> tauri::Url {
    // WebView2 only routes custom schemes through http://<scheme>.localhost.
    let url = if cfg!(target_os = "windows") {
        format!("http://{SCHEME}.localhost/{id}")
    } else {
        format!("{SCHEME}://localhost/{id}")
    };
    tauri::Url::parse(&url).unwrap()
}

/// Render `html` to PDF bytes. Blocks; call from a worker thread.
pub fn html_to_pdf(app: &AppHandle, html: &str, opts: &PdfOptions) -> Result<Vec<u8>, String> {
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let id = format!("{n}");
    PAGES
        .lock()
        .unwrap()
        .get_or_insert_with(HashMap::new)
        .insert(id.clone(), html.to_string());
    let out = std::env::temp_dir().join(format!("magnolia-print-{}-{n}.pdf", std::process::id()));
    let result = render(app, &id, &out, opts);
    PAGES.lock().unwrap().as_mut().map(|m| m.remove(&id));
    let _ = std::fs::remove_file(&out);
    let pdf = result?;
    if opts.header_logo_svg.is_some() || opts.page_numbers {
        return stamp::stamp(&pdf, opts).or(Ok(pdf));
    }
    Ok(pdf)
}

fn render(
    app: &AppHandle,
    id: &str,
    out: &std::path::Path,
    opts: &PdfOptions,
) -> Result<Vec<u8>, String> {
    let label = format!("{LABEL_PREFIX}{id}");
    let (loaded_tx, loaded_rx) = mpsc::channel::<()>();
    let loaded_tx = Mutex::new(Some(loaded_tx));
    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::CustomProtocol(page_url(id)))
        .visible(false)
        .inner_size(opts.page_width * 96.0, opts.page_height * 96.0)
        .on_page_load(move |_, p| {
            if matches!(p.event(), tauri::webview::PageLoadEvent::Finished)
                && let Some(tx) = loaded_tx.lock().unwrap().take()
            {
                let _ = tx.send(());
            }
        })
        .build()
        .map_err(|e| format!("Could not create print window: {e}"))?;
    let result = (|| {
        loaded_rx
            .recv_timeout(Duration::from_secs(60))
            .map_err(|_| "Timed out loading the document to print".to_string())?;
        // Let image decodes settle.
        std::thread::sleep(Duration::from_millis(300));
        print_to_file(app, &window, out, opts)?;
        std::fs::read(out).map_err(|e| format!("Printing produced no PDF: {e}"))
    })();
    let _ = window.destroy();
    result
}

fn print_to_file(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
    out: &std::path::Path,
    opts: &PdfOptions,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return macos::print(app, window, out, opts);
    #[cfg(target_os = "windows")]
    return windows::print(app, window, out, opts);
    #[cfg(target_os = "linux")]
    return linux::print(app, window, out, opts);
}
