//! Translations for the text the backend shows itself: the menus, file
//! dialogs, window titles, error boxes and update messages. They live in
//! the renderer's catalogues (src/renderer/locales/<language>.json), under
//! "native", so each language is one file; they're embedded at build time.
//!
//! The renderer resolves the language (the one chosen in Preferences, or
//! the computer's) and reports it with `set_native_language`. Until then,
//! at launch, a language chosen in Preferences applies straight away.

use serde_json::Value;
use std::sync::{OnceLock, RwLock};
use tauri::AppHandle;

const CATALOGUES: &[(&str, &str)] = &[
    ("en", include_str!("../../src/renderer/locales/en.json")),
    ("es", include_str!("../../src/renderer/locales/es.json")),
    ("nl", include_str!("../../src/renderer/locales/nl.json")),
    ("pt-BR", include_str!("../../src/renderer/locales/pt-BR.json")),
];

static LANGUAGE: RwLock<String> = RwLock::new(String::new());

fn catalogues() -> &'static [(&'static str, Value)] {
    static PARSED: OnceLock<Vec<(&'static str, Value)>> = OnceLock::new();
    PARSED.get_or_init(|| {
        CATALOGUES
            .iter()
            .map(|(id, text)| (*id, serde_json::from_str(text).unwrap_or(Value::Null)))
            .collect()
    })
}

fn lookup(language: &str, key: &str) -> Option<String> {
    let (_, root) = catalogues().iter().find(|(id, _)| *id == language)?;
    let mut v = root.get("native")?;
    for part in key.split('.') {
        v = v.get(part)?;
    }
    v.as_str().map(str::to_string)
}

/// The current language's id ("en" until one is set).
pub fn language() -> String {
    let l = LANGUAGE.read().unwrap();
    if l.is_empty() { "en".into() } else { l.clone() }
}

/// Switch language; an id Magnolia doesn't have means English. Returns
/// whether the language changed.
fn set_language(language: &str) -> bool {
    let id = if catalogues().iter().any(|(id, _)| *id == language) { language } else { "en" };
    let mut current = LANGUAGE.write().unwrap();
    if current.as_str() == id {
        return false;
    }
    *current = id.to_string();
    true
}

/// `native.<key>` in the current language, else in English, else the key.
pub fn t(key: &str) -> String {
    lookup(&language(), key)
        .or_else(|| lookup("en", key))
        .unwrap_or_else(|| key.to_string())
}

/// `t` with each `{{name}}` replaced by its value.
pub fn t_with(key: &str, vars: &[(&str, &str)]) -> String {
    let mut text = t(key);
    for (name, value) in vars {
        text = text.replace(&format!("{{{{{name}}}}}"), value);
    }
    text
}

/// At launch: the language chosen in Preferences, if it isn't "system"
/// (which only the renderer can resolve).
pub fn init_from_preferences(prefs: &Value) {
    if let Some(language) = prefs.get("language").and_then(Value::as_str)
        && language != "system"
    {
        set_language(language);
    }
}

/// The renderer reports the interface language (`language`, resolved) and
/// the preference it came from (`preference`: a language id or "system"):
/// rebuild the menu in it.
#[tauri::command]
pub fn set_native_language(app: AppHandle, language: String, preference: String) {
    #[cfg(target_os = "macos")]
    set_apple_languages((preference != "system").then_some(language.as_str()));
    #[cfg(not(target_os = "macos"))]
    let _ = preference;
    if set_language(&language) {
        // Titles first: the View menu lists the windows by title.
        crate::windows::retitle(&app);
        crate::menu::rebuild(&app);
    }
}

/// macOS draws its own panels (open and save dialogs) and some menu items
/// in the app's preferred language, read at launch from its AppleLanguages
/// default. A language chosen in Preferences is saved there, so from the
/// next launch they match; following the system clears it, so they (and
/// the webviews' navigator.languages) follow the system again.
#[cfg(target_os = "macos")]
fn set_apple_languages(chosen: Option<&str>) {
    use objc2_foundation::{NSArray, NSString, NSUserDefaults};
    let defaults = NSUserDefaults::standardUserDefaults();
    let key = NSString::from_str("AppleLanguages");
    match chosen {
        Some(id) => {
            let languages = NSArray::from_retained_slice(&[NSString::from_str(id)]);
            unsafe { defaults.setObject_forKey(Some(&languages), &key) };
        }
        None => defaults.removeObjectForKey(&key),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_catalogue_parses_with_a_native_section() {
        for (id, value) in catalogues() {
            assert!(value.get("native").is_some(), "{id} has no native section");
        }
    }

    #[test]
    fn looks_up_falls_back_and_fills_in() {
        assert_eq!(lookup("en", "menu.file").as_deref(), Some("File"));
        assert_eq!(lookup("es", "menu.file").as_deref(), Some("Archivo"));
        assert_eq!(lookup("en", "no.such.key"), None);
        let text = lookup("en", "import.unsupported").unwrap().replace("{{ext}}", "xyz");
        assert_eq!(text, "Magnolia can't import .xyz files.");
    }
}
