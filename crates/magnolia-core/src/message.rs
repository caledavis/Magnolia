//! Text the core shows people: error messages and project-loading stages.
//!
//! Each message has a key (under "native.core" in the app's catalogues) and
//! its English, written at the call site so the core reads and tests on its
//! own. An app that shows the messages in other languages installs a
//! translator with `set_translator`; without one, or for a key it doesn't
//! know, the English is used. Placeholders are written `{{name}}`, as in
//! the catalogues.

use std::sync::OnceLock;

/// Looks up `core.<key>` in the interface language. For a counted message
/// `count` is given, and the translator picks the plural form itself.
pub type Translator = fn(key: &str, count: Option<usize>) -> Option<String>;

/// Writes a whole number as the interface language does ("1,234",
/// "1.234").
pub type NumberFormatter = fn(n: u64) -> String;

static TRANSLATOR: OnceLock<Translator> = OnceLock::new();
static NUMBER_FORMATTER: OnceLock<NumberFormatter> = OnceLock::new();

/// Install the translator (once, at launch).
pub fn set_translator(translator: Translator) {
    let _ = TRANSLATOR.set(translator);
}

/// Install the number formatter (once, at launch).
pub fn set_number_formatter(formatter: NumberFormatter) {
    let _ = NUMBER_FORMATTER.set(formatter);
}

/// A whole number for a message: as the interface language writes it, or
/// plain digits without a formatter.
pub fn number(n: u64) -> String {
    NUMBER_FORMATTER
        .get()
        .map_or_else(|| n.to_string(), |f| f(n))
}

fn fill(mut text: String, vars: &[(&str, &str)]) -> String {
    for (name, value) in vars {
        text = text.replace(&format!("{{{{{name}}}}}"), value);
    }
    text
}

/// The message `key`, whose English is `english`, with each `{{name}}`
/// replaced by its value.
pub fn tr(key: &str, english: &str, vars: &[(&str, &str)]) -> String {
    let text = TRANSLATOR
        .get()
        .and_then(|t| t(key, None))
        .unwrap_or_else(|| english.to_string());
    fill(text, vars)
}

/// A message about `count` things: `one` and `other` are its English
/// forms, and `{{count}}` is replaced too.
pub fn tr_count(key: &str, one: &str, other: &str, count: usize, vars: &[(&str, &str)]) -> String {
    let text = TRANSLATOR
        .get()
        .and_then(|t| t(key, Some(count)))
        .unwrap_or_else(|| if count == 1 { one } else { other }.to_string());
    let count = number(count as u64);
    let mut all = vec![("count", count.as_str())];
    all.extend_from_slice(vars);
    fill(text, &all)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn english_without_a_translator() {
        assert_eq!(
            tr("x", "Could not read {{what}}", &[("what", "it")]),
            "Could not read it"
        );
        assert_eq!(
            tr_count("y", "{{count}} file", "{{count}} files", 1, &[]),
            "1 file"
        );
        assert_eq!(
            tr_count("y", "{{count}} file", "{{count}} files", 3, &[]),
            "3 files"
        );
    }
}
