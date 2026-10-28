//! Import-time document conversion.
//!
//! Word, RTF and OpenDocument text documents become HTML here; the app then
//! renders that HTML to PDF with the platform webview and the renderer
//! extracts the text with pdf.js, so every office format lands as an ordinary
//! PDF source. Spreadsheets become CSV for the survey importer, and image
//! formats the webview can't display become PNG.

pub mod docx;
pub mod html;
pub mod image;
pub mod media;
pub mod odt;
pub mod rtf;
pub mod xlsx;
