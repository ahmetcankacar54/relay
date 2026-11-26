//! Port of tests/i18n-catalogs.test.ts: the cases that check catalogs and locale resolution.
//! Its placeholder/tag lints and source scans stay in the TS suite (they check the TS sources the
//! JSON is exported from); rich `<tag>` formatting is renderer-only.

use relay_i18n::{LanguagePref, Locale, catalog, check_message, match_locale, resolve_locale};

#[test]
fn exactly_the_english_ids_and_no_empty_message() {
    let mut english: Vec<&String> = catalog(Locale::En).keys().collect();
    english.sort();
    for locale in Locale::ALL {
        let mut ids: Vec<&String> = catalog(locale).keys().collect();
        ids.sort();
        assert_eq!(ids, english, "{locale}");
        for (id, message) in catalog(locale) {
            assert!(!message.trim().is_empty(), "{locale}: {id} is empty");
        }
    }
}

#[test]
fn every_message_parses() {
    let mut problems = Vec::new();
    for locale in Locale::ALL {
        for (id, message) in catalog(locale) {
            if let Err(error) = check_message(message) {
                problems.push(format!("{locale}: {id} does not parse: {error}"));
            }
        }
    }
    assert_eq!(problems, Vec::<String>::new());
}

#[test]
fn system_languages_resolve_to_the_supported_ones() {
    let system = Some(LanguagePref::System);
    assert_eq!(resolve_locale(system, &["de-AT"]), Locale::De);
    assert_eq!(resolve_locale(system, &["zh-TW"]), Locale::ZhHant);
    assert_eq!(resolve_locale(system, &["zh-CN"]), Locale::ZhHans);
    assert_eq!(resolve_locale(system, &["zh-Hant-HK"]), Locale::ZhHant);
    assert_eq!(resolve_locale(system, &["pt-PT"]), Locale::PtBr);
    assert_eq!(resolve_locale(system, &["xx", "fr-CA"]), Locale::Fr);
    assert_eq!(resolve_locale(system, &["xx"]), Locale::En);
    assert_eq!(
        resolve_locale(Some(LanguagePref::Locale(Locale::Ja)), &["tr"]),
        Locale::Ja
    );
    assert_eq!(resolve_locale::<&str>(None, &[]), Locale::En);
    assert_eq!(match_locale("tr_TR.UTF-8"), Some(Locale::Tr));
    assert_eq!(match_locale("C"), None);
}
