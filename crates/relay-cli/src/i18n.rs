//! Port of `cli/src/i18n.ts`: the CLI's language and its translator.

use relay_i18n::{Args, Locale, translate};

use crate::io::{Env, env_get};

/// `tFor(locale)`: messages in one language.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct T(pub Locale);

impl T {
    /// `t(id)`.
    pub fn t(self, id: &str) -> String {
        translate(self.0, id, &Args::new())
    }
    /// `t(id, args)`.
    pub fn f(self, id: &str, args: Args) -> String {
        translate(self.0, id, &args)
    }
    pub fn lang(self) -> Locale {
        self.0
    }
}

/// The CLI's language: --lang, then RELAY_LANG (a locale or "system"), then the first
/// supported POSIX locale (LC_ALL, then LC_MESSAGES, then LANG), else English.
pub fn pick_lang(flag: Option<&str>, env: &Env) -> Locale {
    relay_i18n::pick_lang(flag, |name| env_get(env, name).map(str::to_owned))
}
