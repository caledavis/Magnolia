//! WebKitGTK printing to a PDF file (print-to-file backend).

use super::PdfOptions;
use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;
use tauri::AppHandle;
use webkit2gtk::{PrintOperation, PrintOperationExt};

const MM_PER_INCH: f64 = 25.4;

/// GTK's print-to-file printer, by name. The name is translated with the
/// rest of GTK ("Print to File", "Imprimir a archivo", "In Datei
/// drucken"…), so asking for the English one found nothing on a system in
/// another language, and no PDF was made (GitHub issue #38). It's found by
/// what it is instead: the virtual printer that takes PDF (the English
/// name first, should there be more than one).
fn file_printer() -> Option<String> {
    let found: std::rc::Rc<std::cell::RefCell<Vec<String>>> = Default::default();
    let list = found.clone();
    gtk::enumerate_printers(
        move |p| {
            if p.is_virtual() && p.accepts_pdf() {
                list.borrow_mut().push(p.name().to_string());
            }
            false
        },
        true,
    );
    let names = found.take();
    names.iter().find(|n| n.as_str() == "Print to File").or_else(|| names.first()).cloned()
}

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
            let Some(printer) = file_printer() else {
                let _ = tx.send(Err(crate::i18n::t("print.noFilePrinter")));
                return;
            };
            let op = PrintOperation::new(&pv.inner());
            let settings = gtk::PrintSettings::new();
            settings.set_printer(&printer);
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
        .map_err(|_| crate::i18n::t("print.pdfTimedOut"))?
}
