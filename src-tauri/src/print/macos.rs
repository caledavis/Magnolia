//! WKWebView printing to a PDF file via NSPrintOperation.

use super::PdfOptions;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_app_kit::{
    NSPrintInfo, NSPrintJobSavingURL, NSPrintOperation, NSPrintSaveJob, NSPrintingPaginationMode,
    NSWindow,
};
use objc2_foundation::{MainThreadMarker, NSCopying, NSSize, NSString, NSURL};
use objc2_web_kit::WKWebView;
use std::path::Path;
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::AppHandle;

const POINTS: f64 = 72.0;

pub fn print(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
    out: &Path,
    opts: &PdfOptions,
) -> Result<(), String> {
    let ns_window = window.ns_window().map_err(|e| e.to_string())? as usize;
    let path = out.to_string_lossy().into_owned();
    let opts = opts.clone();
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    window
        .with_webview(move |pv| {
            // SAFETY: wry hands us its WKWebView and the window that hosts it,
            // both alive for this callback, which runs on the main thread.
            let result = unsafe {
                let webview = &*(pv.inner() as *const WKWebView);
                let ns_window = &*(ns_window as *const NSWindow);
                start(webview, ns_window, &path, &opts)
            };
            let _ = tx.send(result);
        })
        .map_err(|e| e.to_string())?;
    rx.recv_timeout(Duration::from_secs(30))
        .map_err(|_| "Printing did not start".to_string())??;
    wait_for_completion(app, out)
}

unsafe fn start(
    webview: &WKWebView,
    window: &NSWindow,
    path: &str,
    opts: &PdfOptions,
) -> Result<(), String> {
    let info: Retained<NSPrintInfo> = NSPrintInfo::sharedPrintInfo().copy();
    info.setPaperSize(NSSize::new(
        opts.page_width * POINTS,
        opts.page_height * POINTS,
    ));
    info.setTopMargin(opts.margin_top * POINTS);
    info.setBottomMargin(opts.margin_bottom * POINTS);
    info.setLeftMargin(opts.margin_left * POINTS);
    info.setRightMargin(opts.margin_right * POINTS);
    info.setHorizontalPagination(NSPrintingPaginationMode::Fit);
    info.setVerticalPagination(NSPrintingPaginationMode::Automatic);
    info.setHorizontallyCentered(false);
    info.setVerticallyCentered(false);
    unsafe {
        info.setJobDisposition(NSPrintSaveJob);
        let url = NSURL::fileURLWithPath(&NSString::from_str(path));
        let url: &AnyObject = &url;
        info.dictionary().insert(NSPrintJobSavingURL, url);
    }

    let op: Retained<NSPrintOperation> = unsafe { webview.printOperationWithPrintInfo(&info) };
    op.setShowsPrintPanel(false);
    op.setShowsProgressPanel(false);
    // WKWebView's print view starts zero-sized and prints blank pages unless
    // it's given the web view's size.
    if let Some(view) = op.view() {
        view.setFrame(webview.bounds());
    }
    // The synchronous runOperation renders blank pages for WKWebView; the
    // window-modal variant lays out properly. Completion is detected by
    // polling (see wait_for_completion).
    unsafe {
        op.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
            window,
            None,
            None,
            std::ptr::null_mut(),
        )
    };
    Ok(())
}

/// The PDF is complete once the print operation has ended and the file
/// exists with a stable size.
fn wait_for_completion(app: &AppHandle, out: &Path) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(300);
    let mut last_size = None;
    loop {
        std::thread::sleep(Duration::from_millis(150));
        if Instant::now() > deadline {
            return Err("Timed out while printing to PDF".into());
        }
        let size = std::fs::metadata(out)
            .ok()
            .map(|m| m.len())
            .filter(|s| *s > 0);
        if size.is_none() || size != last_size {
            last_size = size;
            continue;
        }
        let (tx, rx) = mpsc::channel();
        let _ = app.run_on_main_thread(move || {
            let mtm = MainThreadMarker::new().expect("main thread");
            let _ = tx.send(NSPrintOperation::currentOperation(mtm).is_none());
        });
        if rx.recv_timeout(Duration::from_secs(5)).unwrap_or(false) {
            return Ok(());
        }
    }
}
