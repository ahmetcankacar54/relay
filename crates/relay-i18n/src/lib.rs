//! Relay's message catalogs and the ICU MessageFormat subset they use: a port of
//! `shared/i18n/translate.ts` (`tFor`) and `shared/i18n/locales.ts`.
//!
//! The catalogs are `crates/relay-i18n/catalogs/<locale>.json`, exported from
//! `shared/i18n/catalogs` by `scripts/i18n/export-catalogs.ts`, embedded and parsed on first use.

mod format;
mod locale;
mod message;
mod number;

use std::collections::HashMap;
use std::fmt;
use std::sync::OnceLock;

pub use format::{Arg, Args, Tag};
pub use locale::{
    LanguagePref, Locale, match_locale, parse_pref, pick_lang, pick_lang_from_env, resolve_locale,
};

/// Why a message could not be formatted; `Display` reads as intl-messageformat's error message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    /// The message is not valid ICU MessageFormat (the parser's error kind).
    Syntax(&'static str),
    /// A placeholder or tag has no value. `message` is the message the error names (none inside
    /// plural/select branches and tags, where intl-messageformat names `undefined`).
    MissingValue {
        name: String,
        message: Option<String>,
    },
    /// A select/plural value has no branch, or a tag's value is not a renderer.
    InvalidValue(String),
    /// Intl.NumberFormat rejected the options.
    Range(String),
    /// `{x, date}`/`{x, time}`: no catalog uses them, so they are not ported.
    Unsupported(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Syntax(kind) => write!(f, "{kind}"),
            Error::MissingValue { name, message } => write!(
                f,
                "The intl string context variable \"{name}\" was not provided to the string \"{}\"",
                message.as_deref().unwrap_or("undefined")
            ),
            Error::InvalidValue(message) | Error::Range(message) => f.write_str(message),
            Error::Unsupported(what) => write!(f, "unsupported {what}"),
        }
    }
}

impl std::error::Error for Error {}

fn catalog_source(locale: Locale) -> &'static str {
    match locale {
        Locale::En => include_str!("../catalogs/en.json"),
        Locale::Tr => include_str!("../catalogs/tr.json"),
        Locale::De => include_str!("../catalogs/de.json"),
        Locale::Fr => include_str!("../catalogs/fr.json"),
        Locale::Es => include_str!("../catalogs/es.json"),
        Locale::PtBr => include_str!("../catalogs/pt-BR.json"),
        Locale::It => include_str!("../catalogs/it.json"),
        Locale::Ja => include_str!("../catalogs/ja.json"),
        Locale::Ko => include_str!("../catalogs/ko.json"),
        Locale::ZhHans => include_str!("../catalogs/zh-Hans.json"),
        Locale::ZhHant => include_str!("../catalogs/zh-Hant.json"),
        Locale::Ru => include_str!("../catalogs/ru.json"),
        Locale::Uk => include_str!("../catalogs/uk.json"),
        Locale::Pl => include_str!("../catalogs/pl.json"),
        Locale::Nl => include_str!("../catalogs/nl.json"),
    }
}

/// `locale`'s messages by id, parsed from the embedded JSON on first use.
pub fn catalog(locale: Locale) -> &'static HashMap<String, String> {
    static CATALOGS: [OnceLock<HashMap<String, String>>; 15] = [const { OnceLock::new() }; 15];
    CATALOGS[locale as usize].get_or_init(|| {
        serde_json::from_str(catalog_source(locale))
            .expect("embedded catalogs are valid JSON objects")
    })
}

fn run(
    elements: &[message::Element],
    locale: Locale,
    args: &Args,
    tags: &[Tag<'_>],
    original: &str,
) -> Result<String, Error> {
    let mut out = String::new();
    format::format_elements(
        &format::Context { locale, args, tags },
        elements,
        None,
        Some(original),
        &mut out,
    )?;
    Ok(out)
}

/// Formats one ICU message in `locale`'s number and plural conventions, like
/// `new IntlMessageFormat(message, FORMAT_LOCALE[locale], undefined, { ignoreTag: true }).format(args)`.
pub fn format_message(message: &str, locale: Locale, args: &Args) -> Result<String, Error> {
    run(
        &message::parse(message).map_err(Error::Syntax)?,
        locale,
        args,
        &[],
        message,
    )
}

/// [`format_message`] with `<tag>…</tag>` parts rendered by `tags` (the renderer's `formatRich`
/// values that are functions). A tag without a renderer fails, as in intl-messageformat.
pub fn format_message_rich(
    message: &str,
    locale: Locale,
    args: &Args,
    tags: &[Tag<'_>],
) -> Result<String, Error> {
    run(
        &message::parse_rich(message).map_err(Error::Syntax)?,
        locale,
        args,
        tags,
        message,
    )
}

/// Whether `message` is valid ICU MessageFormat as `tFor` parses it (the catalog lint).
pub fn check_message(message: &str) -> Result<(), Error> {
    message::parse(message).map(drop).map_err(Error::Syntax)
}

/// A message source by locale and id; the embedded catalogs outside tests.
type Lookup<'a> = dyn Fn(Locale, &str) -> Option<&'a str> + 'a;

/// `format(locale, id)` then `.format(args)` in translate.ts: the locale's text (else English,
/// else the id); a translation that does not parse is replaced by English in English conventions.
fn format_in(lookup: &Lookup<'_>, locale: Locale, id: &str, args: &Args) -> Result<String, Error> {
    let english = lookup(Locale::En, id).unwrap_or(id);
    let source = lookup(locale, id).unwrap_or(english);
    match message::parse(source) {
        Ok(elements) => run(&elements, locale, args, &[], source),
        Err(_) => run(
            &message::parse(english).map_err(Error::Syntax)?,
            Locale::En,
            args,
            &[],
            english,
        ),
    }
}

fn translate_in(
    lookup: &Lookup<'_>,
    locale: Locale,
    id: &str,
    args: &Args,
) -> Result<String, Error> {
    format_in(lookup, locale, id, args).or_else(|_| format_in(lookup, Locale::En, id, args))
}

fn embedded(locale: Locale, id: &str) -> Option<&'static str> {
    catalog(locale).get(id).map(String::as_str)
}

/// `tFor(locale)(id, args)`: the message in `locale`, falling back to English when the id is
/// missing there or the translation fails to parse or format. `Err` only when English fails too
/// (where the TS throws), e.g. a placeholder without a value.
pub fn try_translate(locale: Locale, id: &str, args: &Args) -> Result<String, Error> {
    translate_in(&embedded, locale, id, args)
}

/// [`try_translate`], but never failing: where the TS would throw, the raw English message (or
/// the id) stands in, so a missing placeholder cannot abort a command.
pub fn translate(locale: Locale, id: &str, args: &Args) -> String {
    try_translate(locale, id, args)
        .unwrap_or_else(|_| embedded(Locale::En, id).unwrap_or(id).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The embedded catalogs with `(locale, id) → message` overrides, like `registerCatalog`.
    fn with<'a>(
        overrides: &'a [(Locale, &'a str, &'a str)],
    ) -> impl Fn(Locale, &str) -> Option<&'a str> + 'a {
        move |locale, id| {
            overrides
                .iter()
                .find(|(l, i, _)| *l == locale && *i == id)
                .map(|(_, _, m)| *m)
                .or_else(|| embedded(locale, id))
        }
    }

    const ID: &str = "antigravityAccount.quitsAndOpensOnName";

    #[test]
    fn a_message_that_fails_to_parse_in_its_language_reads_in_english() {
        let lookup = with(&[(Locale::De, ID, "{name beendet")]);
        let args = Args::new().set("name", "Max");
        assert_eq!(
            translate_in(&lookup, Locale::De, ID, &args).unwrap(),
            "Antigravity quits and opens on <b>Max</b>. Running work stops."
        );
    }

    #[test]
    fn a_message_that_fails_to_format_in_its_language_reads_in_english() {
        let lookup = with(&[(Locale::De, ID, "{other} beendet")]);
        let args = Args::new().set("name", "Max");
        assert_eq!(
            translate_in(&lookup, Locale::De, ID, &args).unwrap(),
            "Antigravity quits and opens on <b>Max</b>. Running work stops."
        );
    }

    #[test]
    fn english_conventions_follow_the_english_fallback() {
        let lookup = with(&[
            (
                Locale::De,
                "x",
                "{n, plural, one {# Datei} other {# Dateien}",
            ),
            (Locale::En, "x", "{n, number} files"),
        ]);
        let args = Args::new().set("n", 1234.5);
        assert_eq!(
            translate_in(&lookup, Locale::De, "x", &args).unwrap(),
            "1,234.5 files"
        );
        let lookup = with(&[
            (Locale::De, "x", "{n, number} Dateien"),
            (Locale::En, "x", "{n, number} files"),
        ]);
        assert_eq!(
            translate_in(&lookup, Locale::De, "x", &args).unwrap(),
            "1.234,5 Dateien"
        );
    }

    #[test]
    fn ids_missing_from_a_catalog_read_in_english_and_unknown_ids_read_as_themselves() {
        let lookup = with(&[(Locale::En, "only.english", "Only {what}")]);
        assert_eq!(
            translate_in(
                &lookup,
                Locale::Tr,
                "only.english",
                &Args::new().set("what", "x")
            )
            .unwrap(),
            "Only x"
        );
        assert_eq!(
            translate(Locale::Tr, "no.such.id", &Args::new()),
            "no.such.id"
        );
    }

    #[test]
    fn a_missing_value_fails_only_when_english_fails_too() {
        let err = try_translate(Locale::Tr, ID, &Args::new()).unwrap_err();
        let english = embedded(Locale::En, ID).unwrap();
        assert_eq!(
            err,
            Error::MissingValue {
                name: "name".into(),
                message: Some(english.into())
            }
        );
        assert_eq!(
            err.to_string(),
            format!(
                "The intl string context variable \"name\" was not provided to the string \"{english}\""
            )
        );
    }

    #[test]
    fn rich_messages_render_tags_and_fail_without_a_renderer() {
        let bold = |s: &str| format!("[{s}]");
        let args = Args::new().set("name", "Max");
        let message = embedded(Locale::En, ID).unwrap();
        let out = format_message_rich(message, Locale::En, &args, &[("b", &bold)]).unwrap();
        assert_eq!(
            out,
            "Antigravity quits and opens on [Max]. Running work stops."
        );
        let err = format_message_rich(message, Locale::En, &args, &[]).unwrap_err();
        assert_eq!(
            err.to_string(),
            format!(
                "The intl string context variable \"b\" was not provided to the string \"{message}\""
            )
        );
        let err = format_message_rich(message, Locale::En, &args.set("b", "x"), &[]).unwrap_err();
        assert_eq!(err.to_string(), "Value for \"b\" must be of type function");
        assert_eq!(
            format_message_rich("a <b>x</c>", Locale::En, &Args::new(), &[]),
            Err(Error::Syntax("UNMATCHED_CLOSING_TAG"))
        );
        assert_eq!(
            format_message_rich("a <br/> '<b>' <1", Locale::En, &Args::new(), &[]).unwrap(),
            "a <br/> <b> <1"
        );
        assert_eq!(
            translate(Locale::Tr, ID, &Args::new()),
            embedded(Locale::En, ID).unwrap()
        );
    }
}
