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
    (
        "pt-BR",
        include_str!("../../src/renderer/locales/pt-BR.json"),
    ),
    ("ar", include_str!("../../src/renderer/locales/ar.json")),
    ("fr", include_str!("../../src/renderer/locales/fr.json")),
    ("ru", include_str!("../../src/renderer/locales/ru.json")),
    (
        "zh-Hans",
        include_str!("../../src/renderer/locales/zh-Hans.json"),
    ),
    ("it", include_str!("../../src/renderer/locales/it.json")),
    ("hi", include_str!("../../src/renderer/locales/hi.json")),
    (
        "pt-PT",
        include_str!("../../src/renderer/locales/pt-PT.json"),
    ),
    ("de", include_str!("../../src/renderer/locales/de.json")),
    ("fi", include_str!("../../src/renderer/locales/fi.json")),
];

static LANGUAGE: RwLock<String> = RwLock::new(String::new());
/// The locale the core's numbers are written in: the language, with the
/// digits chosen in Preferences ("ar-u-nu-latn"). Empty means the language.
static NUMBER_LOCALE: RwLock<String> = RwLock::new(String::new());

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
    let id = if catalogues().iter().any(|(id, _)| *id == language) {
        language
    } else {
        "en"
    };
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

/// The language's CLDR locale (English for an id ICU can't parse).
fn locale(language: &str) -> icu_locale_core::Locale {
    icu_locale_core::Locale::try_from_str(language).unwrap_or(icu_locale_core::locale!("en"))
}

/// The language's cardinal plural rules, from the CLDR data built into
/// ICU4X, so every language gets its own rules without code here.
fn plural_rules(language: &str) -> Option<icu_plurals::PluralRules> {
    icu_plurals::PluralRules::try_new_cardinal((&locale(language)).into()).ok()
}

/// A plural category as i18next names it in the catalogues' key suffixes.
fn category_name(c: icu_plurals::PluralCategory) -> &'static str {
    use icu_plurals::PluralCategory::*;
    match c {
        Zero => "zero",
        One => "one",
        Two => "two",
        Few => "few",
        Many => "many",
        Other => "other",
    }
}

/// The CLDR plural category of a whole number in `language`.
fn plural_category(language: &str, n: usize) -> &'static str {
    match plural_rules(language) {
        Some(rules) => category_name(rules.category_for(n)),
        None if n == 1 => "one",
        None => "other",
    }
}

/// The core's translator (`magnolia_core::message`): `native.core.<key>`
/// in the current language, with the plural form for `count`. None leaves
/// the core's own English.
fn core_message(key: &str, count: Option<usize>) -> Option<String> {
    let language = language();
    let key = match count {
        Some(n) => format!("core.{key}_{}", plural_category(&language, n)),
        None => format!("core.{key}"),
    };
    lookup(&language, &key)
}

/// A whole number written as `language` writes it (its digits, grouping
/// separator and where grouping starts, from CLDR via ICU4X).
fn group_digits(language: &str, n: u64) -> String {
    match icu_decimal::DecimalFormatter::try_new((&locale(language)).into(), Default::default()) {
        Ok(f) => f.format(&fixed_decimal::Decimal::from(n)).to_string(),
        Err(_) => n.to_string(),
    }
}

fn core_number(n: u64) -> String {
    let mut locale = NUMBER_LOCALE.read().unwrap().clone();
    if locale.is_empty() {
        locale = language();
    }
    group_digits(&locale, n)
}

/// Give the core this module's translations and number format.
pub fn install_core_translator() {
    magnolia_core::message::set_translator(core_message);
    magnolia_core::message::set_number_formatter(core_number);
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

/// The renderer reports the interface language (`language`, resolved),
/// the preference it came from (`preference`: a language id or "system")
/// and the locale for numbers (`number_locale`, with the chosen digits):
/// rebuild the menu in it.
#[tauri::command]
pub fn set_native_language(
    app: AppHandle,
    language: String,
    preference: String,
    number_locale: Option<String>,
) {
    *NUMBER_LOCALE.write().unwrap() = number_locale.unwrap_or_default();
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

/// The computer's region locale as macOS keeps it ("ar_EG", or
/// "ar_EG@numbers=latn" when the digits are overridden), for the renderer
/// to follow the computer's digits. Empty elsewhere: the renderer then
/// goes by the system language's region.
#[tauri::command]
pub fn system_locale() -> String {
    #[cfg(target_os = "macos")]
    {
        use objc2_foundation::{NSString, NSUserDefaults};
        let defaults = NSUserDefaults::standardUserDefaults();
        if let Some(s) = defaults.stringForKey(&NSString::from_str("AppleLocale")) {
            return s.to_string();
        }
    }
    String::new()
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
        let text = lookup("en", "import.unsupported")
            .unwrap()
            .replace("{{ext}}", "xyz");
        assert_eq!(text, "Magnolia can't import .xyz files.");
    }

    #[test]
    fn plural_categories() {
        assert_eq!(plural_category("en", 1), "one");
        assert_eq!(plural_category("en", 0), "other");
        assert_eq!(plural_category("nl", 2), "other");
        assert_eq!(plural_category("es", 1), "one");
        assert_eq!(plural_category("es", 0), "other");
        assert_eq!(plural_category("es", 1_000_000), "many");
        assert_eq!(plural_category("pt-BR", 0), "one");
        assert_eq!(plural_category("pt-BR", 2), "other");
        assert_eq!(plural_category("pt-BR", 2_000_000), "many");
    }

    /// Every catalogue's plural keys have exactly the forms ICU's rules for
    /// that language produce, so a new language's catalogue can't miss one
    /// (or carry one the backend never asks for).
    #[test]
    fn catalogue_plurals_match_the_language_rules() {
        fn walk(v: &Value, prefix: &str, out: &mut Vec<String>) {
            if let Some(map) = v.as_object() {
                for (k, v) in map {
                    walk(v, &format!("{prefix}.{k}"), out);
                }
            } else {
                out.push(prefix.to_string());
            }
        }
        for (id, value) in catalogues() {
            let rules = plural_rules(id).unwrap_or_else(|| panic!("no plural rules for {id}"));
            let mut want: Vec<&str> = rules.categories().map(category_name).collect();
            want.sort();
            let mut keys = Vec::new();
            walk(&value["native"], "native", &mut keys);
            let bases: Vec<&str> = keys
                .iter()
                .filter_map(|k| k.strip_suffix("_other"))
                .collect();
            assert!(!bases.is_empty());
            for base in bases {
                let mut got: Vec<&str> = keys
                    .iter()
                    .filter_map(|k| k.strip_prefix(base)?.strip_prefix('_'))
                    .filter(|s| !s.contains('.'))
                    .collect();
                got.sort();
                assert_eq!(got, want, "{id}: {base}");
            }
        }
    }

    /// Every catalogue in src/renderer/locales is embedded here.
    #[test]
    fn embeds_every_catalogue() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/renderer/locales");
        let mut on_disk: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| {
                e.ok()?
                    .file_name()
                    .to_str()?
                    .strip_suffix(".json")
                    .map(str::to_string)
            })
            .collect();
        on_disk.sort();
        let mut embedded: Vec<&str> = CATALOGUES.iter().map(|(id, _)| *id).collect();
        embedded.sort();
        assert_eq!(on_disk, embedded);
    }

    #[test]
    fn groups_digits_by_language() {
        assert_eq!(group_digits("en", 999), "999");
        assert_eq!(group_digits("en", 1234), "1,234");
        assert_eq!(group_digits("en", 1_234_567), "1,234,567");
        assert_eq!(group_digits("nl", 1234), "1.234");
        assert_eq!(group_digits("pt-BR", 12_345), "12.345");
        assert_eq!(group_digits("es", 1234), "1234");
        assert_eq!(group_digits("es", 12_345), "12.345");
        // Languages Magnolia doesn't have yet get theirs too.
        assert_eq!(group_digits("fr", 1234).replace('\u{202f}', " "), "1 234");
        assert_eq!(plural_category("pl", 3), "few");
        // Digits chosen in Preferences come as a Unicode extension.
        assert_eq!(group_digits("ar-EG", 1234), "١٬٢٣٤");
        assert_eq!(group_digits("ar-u-nu-arab", 1234), "١٬٢٣٤");
        assert_eq!(group_digits("ar-EG-u-nu-latn", 1234), "1,234");
    }
}
