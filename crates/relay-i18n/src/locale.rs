//! Port of `shared/i18n/locales.ts` and the CLI's `pickLang` (`cli/src/i18n.ts`).

use std::fmt;

/// The languages Relay speaks, in `LOCALES` order. English is the source.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Locale {
    En,
    Tr,
    De,
    Fr,
    Es,
    PtBr,
    It,
    Ja,
    Ko,
    ZhHans,
    ZhHant,
    Ru,
    Uk,
    Pl,
    Nl,
}

impl Locale {
    /// Every locale, in `LOCALES` order.
    pub const ALL: [Locale; 15] = [
        Locale::En,
        Locale::Tr,
        Locale::De,
        Locale::Fr,
        Locale::Es,
        Locale::PtBr,
        Locale::It,
        Locale::Ja,
        Locale::Ko,
        Locale::ZhHans,
        Locale::ZhHant,
        Locale::Ru,
        Locale::Uk,
        Locale::Pl,
        Locale::Nl,
    ];

    /// The id Relay stores and passes around (`"pt-BR"`, `"zh-Hans"`, …).
    pub const fn as_str(self) -> &'static str {
        match self {
            Locale::En => "en",
            Locale::Tr => "tr",
            Locale::De => "de",
            Locale::Fr => "fr",
            Locale::Es => "es",
            Locale::PtBr => "pt-BR",
            Locale::It => "it",
            Locale::Ja => "ja",
            Locale::Ko => "ko",
            Locale::ZhHans => "zh-Hans",
            Locale::ZhHant => "zh-Hant",
            Locale::Ru => "ru",
            Locale::Uk => "uk",
            Locale::Pl => "pl",
            Locale::Nl => "nl",
        }
    }

    /// The locale with exactly this id (`isLocale`): case-sensitive, no tag matching.
    pub fn parse(id: &str) -> Option<Locale> {
        Locale::ALL.into_iter().find(|l| l.as_str() == id)
    }

    /// The language in its own words (`LOCALE_NAMES`).
    pub const fn native_name(self) -> &'static str {
        match self {
            Locale::En => "English",
            Locale::Tr => "Türkçe",
            Locale::De => "Deutsch",
            Locale::Fr => "Français",
            Locale::Es => "Español",
            Locale::PtBr => "Português (Brasil)",
            Locale::It => "Italiano",
            Locale::Ja => "日本語",
            Locale::Ko => "한국어",
            Locale::ZhHans => "简体中文",
            Locale::ZhHant => "繁體中文",
            Locale::Ru => "Русский",
            Locale::Uk => "Українська",
            Locale::Pl => "Polski",
            Locale::Nl => "Nederlands",
        }
    }

    /// The Intl locale behind numbers (`FORMAT_LOCALE`); English uses en-GB.
    pub const fn format_locale(self) -> &'static str {
        match self {
            Locale::En => "en-GB",
            Locale::Tr => "tr-TR",
            Locale::De => "de-DE",
            Locale::Fr => "fr-FR",
            Locale::Es => "es-ES",
            Locale::PtBr => "pt-BR",
            Locale::It => "it-IT",
            Locale::Ja => "ja-JP",
            Locale::Ko => "ko-KR",
            Locale::ZhHans => "zh-CN",
            Locale::ZhHant => "zh-TW",
            Locale::Ru => "ru-RU",
            Locale::Uk => "uk-UA",
            Locale::Pl => "pl-PL",
            Locale::Nl => "nl-NL",
        }
    }
}

impl fmt::Display for Locale {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The language setting: a language, or whatever the system prefers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LanguagePref {
    System,
    Locale(Locale),
}

/// The supported language a BCP 47 tag or a POSIX locale (`tr_TR.UTF-8`) means, if any.
pub fn match_locale(tag: &str) -> Option<Locale> {
    let base = tag.split('.').next().unwrap_or("");
    let clean = base
        .split('@')
        .next()
        .unwrap_or("")
        .replace('_', "-")
        .to_lowercase();
    if clean.is_empty() || clean == "c" || clean == "posix" {
        return None;
    }
    let mut parts = clean.split('-');
    let language = parts.next().unwrap_or("");
    let rest: Vec<&str> = parts.collect();
    match language {
        "zh" if rest
            .iter()
            .any(|r| matches!(*r, "hant" | "tw" | "hk" | "mo")) =>
        {
            Some(Locale::ZhHant)
        }
        "zh" => Some(Locale::ZhHans),
        "pt" => Some(Locale::PtBr),
        _ => Locale::parse(language),
    }
}

/// A stored or passed preference, if it is one (`"system"` or an exact locale id).
pub fn parse_pref(value: &str) -> Option<LanguagePref> {
    if value == "system" {
        Some(LanguagePref::System)
    } else {
        Locale::parse(value).map(LanguagePref::Locale)
    }
}

/// The language to speak: an explicit choice, else the first supported system language, else English.
pub fn resolve_locale<S: AsRef<str>>(pref: Option<LanguagePref>, system: &[S]) -> Locale {
    if let Some(LanguagePref::Locale(locale)) = pref {
        return locale;
    }
    system
        .iter()
        .find_map(|tag| match_locale(tag.as_ref()))
        .unwrap_or(Locale::En)
}

/// The CLI's language: `--lang`, then `RELAY_LANG` (a locale or `"system"`), then the first
/// supported POSIX locale (`LC_ALL`, then `LC_MESSAGES`, then `LANG`), else English.
/// `env` reads one variable; unset and empty are the same.
pub fn pick_lang(flag: Option<&str>, env: impl Fn(&str) -> Option<String>) -> Locale {
    let pref = flag
        .and_then(parse_pref)
        .or_else(|| env("RELAY_LANG").as_deref().and_then(parse_pref))
        .unwrap_or(LanguagePref::System);
    let system: Vec<String> = ["LC_ALL", "LC_MESSAGES", "LANG"]
        .into_iter()
        .filter_map(|name| env(name).filter(|v| !v.is_empty()))
        .map(|v| v.split('.').next().unwrap_or("").to_string())
        .collect();
    resolve_locale(Some(pref), &system)
}

/// [`pick_lang`] over this process's environment.
pub fn pick_lang_from_env(flag: Option<&str>) -> Locale {
    pick_lang(flag, |name| {
        std::env::var_os(name).map(|v| v.to_string_lossy().into_owned())
    })
}
