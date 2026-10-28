//! WebView2 printing to a PDF file (`ICoreWebView2_7::PrintToPdf`).

use super::PdfOptions;
use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;
use tauri::AppHandle;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT, ICoreWebView2_2, ICoreWebView2_7,
    ICoreWebView2Environment6,
};
use webview2_com::PrintToPdfCompletedHandler;
use windows::core::{HSTRING, Interface};

pub fn print(
    _app: &AppHandle,
    window: &tauri::WebviewWindow,
    out: &Path,
    opts: &PdfOptions,
) -> Result<(), String> {
    let path = HSTRING::from(out.as_os_str());
    let opts = opts.clone();
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    let start_tx = tx.clone();
    window
        .with_webview(move |pv| {
            let started = (|| -> windows::core::Result<()> {
                // SAFETY: COM calls on wry's live WebView2 controller, on the
                // thread that owns it.
                unsafe {
                    let core = pv.controller().CoreWebView2()?;
                    let core7: ICoreWebView2_7 = core.cast()?;
                    let env: ICoreWebView2Environment6 =
                        core.cast::<ICoreWebView2_2>()?.Environment()?.cast()?;
                    let settings = env.CreatePrintSettings()?;
                    settings.SetOrientation(COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT)?;
                    settings.SetPageWidth(opts.page_width)?;
                    settings.SetPageHeight(opts.page_height)?;
                    settings.SetMarginTop(opts.margin_top)?;
                    settings.SetMarginBottom(opts.margin_bottom)?;
                    settings.SetMarginLeft(opts.margin_left)?;
                    settings.SetMarginRight(opts.margin_right)?;
                    settings.SetShouldPrintBackgrounds(true)?;
                    settings.SetShouldPrintHeaderAndFooter(false)?;
                    let done = tx.clone();
                    let handler = PrintToPdfCompletedHandler::create(Box::new(move |hr, ok| {
                        let _ = done.send(match (hr, ok) {
                            (Ok(()), true) => Ok(()),
                            (Err(e), _) => Err(e.to_string()),
                            _ => Err("WebView2 could not print the document".into()),
                        });
                        Ok(())
                    }));
                    core7.PrintToPdf(&path, &settings, &handler)
                }
            })();
            if let Err(e) = started {
                let _ = start_tx.send(Err(e.to_string()));
            }
        })
        .map_err(|e| e.to_string())?;
    rx.recv_timeout(Duration::from_secs(300))
        .map_err(|_| "Timed out while printing to PDF".to_string())?
}
