//! Import-time document conversion.
//!
//! Word, RTF and OpenDocument text documents become HTML here, which
//! `typeset` turns into a PDF carrying its own text layer, so every office
//! format lands as an ordinary PDF source. Spreadsheets become CSV for the survey importer, and image
//! formats the webview can't display become PNG.

pub mod docx;
pub mod html;
pub mod html_dom;
pub mod image;
pub mod media;
pub mod odt;
pub mod rtf;
pub mod typeset;
pub mod xlsx;
