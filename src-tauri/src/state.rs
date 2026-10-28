//! Process-wide application state.

use magnolia_core::binary_store::BinaryStore;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Default)]
pub struct AppState {
    /// Imported media bytes and the open project's archive path.
    pub store: BinaryStore,
    pub ui: Mutex<UiState>,
}

#[derive(Default)]
pub struct UiState {
    /// Init data a child window fetches once loaded, keyed by window label.
    pub window_data: HashMap<String, Value>,
    /// Events for a window whose renderer hasn't subscribed yet, keyed by
    /// (window label, event). Delivered when the listener registers, so a
    /// freshly-created main window can't miss "open this project".
    pub queued_events: HashMap<(String, String), Vec<Value>>,
    pub panel_visibility: Option<Value>,
    /// The main window's close is in its flush-on-close handshake.
    pub flush_pending: bool,
    /// Bumped by every renderer heartbeat; a watchdog only fires if it
    /// hasn't moved for the timeout.
    pub flush_generation: u64,
    /// Quit was requested: closing the main window must exit rather than
    /// return to the welcome screen.
    pub is_quitting: bool,
    /// Relaunch after quitting (installing an update).
    pub restart_after_quit: bool,
    /// The welcome window is closing because the main window is opening.
    pub replacing_welcome: bool,
}
