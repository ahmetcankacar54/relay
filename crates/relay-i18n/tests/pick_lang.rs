//! The language cases of tests/cli-core.test.ts (`pickLang`, `translator`), which live here
//! because relay-i18n owns them.

use std::collections::HashMap;

use relay_i18n::{Args, Locale, pick_lang, translate};

fn pick(flag: Option<&str>, env: &[(&str, &str)]) -> Locale {
    let env: HashMap<String, String> = env
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    pick_lang(flag, |name| env.get(name).cloned())
}

#[test]
fn language_flag_then_relay_lang_then_lc_all_lc_messages_lang_else_english() {
    assert_eq!(pick(None, &[("LANG", "tr_TR.UTF-8")]), Locale::Tr);
    assert_eq!(
        pick(None, &[("LC_ALL", "en_US.UTF-8"), ("LANG", "tr_TR.UTF-8")]),
        Locale::En
    );
    assert_eq!(
        pick(
            None,
            &[("LC_MESSAGES", "tr_TR.UTF-8"), ("LANG", "en_US.UTF-8")]
        ),
        Locale::Tr
    );
    assert_eq!(
        pick(None, &[("RELAY_LANG", "tr"), ("LANG", "en_US.UTF-8")]),
        Locale::Tr
    );
    assert_eq!(pick(Some("en"), &[("RELAY_LANG", "tr")]), Locale::En);
    assert_eq!(pick(None, &[]), Locale::En);
    // Every locale, by code or by POSIX locale; C/POSIX and unknown ones fall through.
    assert_eq!(
        pick(Some("zh-Hant"), &[("LANG", "tr_TR.UTF-8")]),
        Locale::ZhHant
    );
    assert_eq!(pick(Some("xx"), &[("LANG", "de_DE.UTF-8")]), Locale::De);
    assert_eq!(
        pick(None, &[("RELAY_LANG", "system"), ("LANG", "ja_JP.UTF-8")]),
        Locale::Ja
    );
    assert_eq!(
        pick(None, &[("LC_ALL", "C"), ("LANG", "pt_PT.UTF-8")]),
        Locale::PtBr
    );
    assert_eq!(pick(None, &[("LANG", "zh_TW.UTF-8")]), Locale::ZhHant);
    assert_eq!(
        translate(Locale::Tr, "confirm.yYes", &Args::new()),
        "e evet y yes"
    );
}

#[test]
fn empty_variables_are_unset_and_system_flag_skips_relay_lang() {
    assert_eq!(
        pick(None, &[("LC_ALL", ""), ("LANG", "fr_FR.UTF-8")]),
        Locale::Fr
    );
    assert_eq!(
        pick(Some("system"), &[("RELAY_LANG", "tr"), ("LANG", "de_DE")]),
        Locale::De
    );
    assert_eq!(
        pick(None, &[("RELAY_LANG", "TR"), ("LANG", "nl_NL")]),
        Locale::Nl
    );
}

#[test]
fn turkish_plural_and_number_messages() {
    let days = |n: i64| {
        translate(
            Locale::Tr,
            "accountBalance.days",
            &Args::new().set("rowIdleDays", n),
        )
    };
    assert_eq!(days(3), "3 gün");
    let en = |n: i64| {
        translate(
            Locale::En,
            "accountBalance.days",
            &Args::new().set("rowIdleDays", n),
        )
    };
    assert_eq!(en(1), "1 day");
    assert_eq!(en(2), "2 days");
}
