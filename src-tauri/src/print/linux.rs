//! WebKitGTK printing to a PDF file (print-to-file backend).

use super::PdfOptions;
use std::ffi::{CStr, c_int, c_void};
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
    let mut names: Vec<String> = Vec::new();
    // SAFETY: `names` outlives the call (`wait` is true, so every printer
    // has been listed when it returns), and is only reached through the
    // callback, on this thread.
    unsafe {
        printers::gtk_enumerate_printers(collect, (&mut names as *mut Vec<String>).cast(), None, 1);
    }
    names.iter().find(|n| n.as_str() == "Print to File").or_else(|| names.first()).cloned()
}

/// Called for each printer: notes the virtual ones that take PDF.
unsafe extern "C" fn collect(printer: *mut printers::GtkPrinter, data: *mut c_void) -> c_int {
    // SAFETY: GTK passes a live printer and our `data` (see file_printer).
    unsafe {
        if printers::gtk_printer_is_virtual(printer) != 0 && printers::gtk_printer_accepts_pdf(printer) != 0 {
            let name = printers::gtk_printer_get_name(printer);
            if !name.is_null() {
                let names = &mut *data.cast::<Vec<String>>();
                names.push(CStr::from_ptr(name).to_string_lossy().into_owned());
            }
        }
    }
    0 // keep going
}

/// GTK's list of printers (gtk/gtkunixprint.h). They're part of GTK 3
/// itself, but the gtk crate doesn't wrap them, so they're declared here.
mod printers {
    use std::ffi::{c_char, c_int, c_void};

    #[repr(C)]
    pub struct GtkPrinter {
        _private: [u8; 0],
    }

    pub type GtkPrinterFunc = unsafe extern "C" fn(*mut GtkPrinter, *mut c_void) -> c_int;

    #[link(name = "gtk-3")]
    unsafe extern "C" {
        pub fn gtk_enumerate_printers(func: GtkPrinterFunc, data: *mut c_void, destroy: Option<unsafe extern "C" fn(*mut c_void)>, wait: c_int);
        pub fn gtk_printer_is_virtual(printer: *mut GtkPrinter) -> c_int;
        pub fn gtk_printer_accepts_pdf(printer: *mut GtkPrinter) -> c_int;
        pub fn gtk_printer_get_name(printer: *mut GtkPrinter) -> *const c_char;
    }
}

pub fn print(
    _app: &AppHandle,
    window: &tauri::WebviewWindow,
    out: &Path,
    opts: &PdfOptions,
) -> Result<(), String> {
    // A URI, so a temporary folder with a space or an accent in its path
    // (TMPDIR) is escaped rather than misread.
    let uri = gtk::glib::filename_to_uri(out, None).map_err(|e| e.to_string())?.to_string();
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
