//! Magnolia's platform-independent core: the REFI-QDA (.qdpx) model,
//! the runtime binary store, and document format conversion. Kept free of
//! any GUI dependency so it builds and tests quickly on its own.

pub mod binary_store;
pub mod convert;
pub mod pdf_info;
pub mod qdpx;
pub mod util;
pub mod xml_build;
pub mod xml_read;
