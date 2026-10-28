//! WebKitGTK printing to a PDF file (print-to-file backend).

use super::PdfOptions;
use gtk::prelude::*;
use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;
use tauri::AppHandle;
use webkit2gtk::{PrintOperation, PrintOperationExt};

const MM_PER_INCH: f64 = 25.4;

pub fn print(
    _app: &AppHandle,
    window: &tauri::WebviewWindow,
    out: &Path,
    opts: &PdfOptions,
) -> Result<(), String> {
    let uri = format!("file://{}", out.to_string_lossy());
    let opts = opts.clone();
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    window
        .with_webview(move |pv| {
            let op = PrintOperation::new(&pv.inner());
            let settings = gtk::PrintSettings::new();
            settings.set_printer("Print to File");
            settings.set(gtk::PRINT_SETTINGS_OUTPUT_FILE_FORMAT, Some("pdf"));
            settings.set(gtk::PRINT_SETTINGS_OUTPUT_URI, Some(&uri));
            let setup = gtk::PageSetup::new();
            let paper = gtk::PaperSize::new_custom(
                "magnolia",
                "Magnolia",
                opts.page_width * MM_PER_INCH,
                opts.page_height * MM_PER_INCH,
                gtk::Unit::Mm,
            );
            setup.set_paper_size(&paper);
            setup.set_orientation(gtk::PageOrientation::Portrait);
            setup.set_top_margin(opts.margin_top * MM_PER_INCH, gtk::Unit::Mm);
            setup.set_bottom_margin(opts.margin_bottom * MM_PER_INCH, gtk::Unit::Mm);
            setup.set_left_margin(opts.margin_left * MM_PER_INCH, gtk::Unit::Mm);
            setup.set_right_margin(opts.margin_right * MM_PER_INCH, gtk::Unit::Mm);
            op.set_print_settings(&settings);
            op.set_page_setup(&setup);
            let done = tx.clone();
            op.connect_finished(move |_| {
                let _ = done.send(Ok(()));
            });
            let failed = tx.clone();
            op.connect_failed(move |_, err| {
                let _ = failed.send(Err(err.to_string()));
            });
            op.print();
        })
        .map_err(|e| e.to_string())?;
    rx.recv_timeout(Duration::from_secs(300))
        .map_err(|_| "Timed out while printing to PDF".to_string())?
}
