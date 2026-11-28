//! The language the app's own surfaces speak: menus, dialogs, notifications, the tray and the
//! widget (port of electron/i18n.ts).

use std::sync::RwLock;

use relay_i18n::{Args, Locale};

static APP_LOCALE: RwLock<Locale> = RwLock::new(Locale::En);

pub fn locale() -> Locale {
    *APP_LOCALE.read().unwrap_or_else(|e| e.into_inner())
}

/// Switches the app's language; true when it changed.
pub fn set_locale(locale: Locale) -> bool {
    let mut current = APP_LOCALE.write().unwrap_or_else(|e| e.into_inner());
    if *current == locale {
        return false;
    }
    *current = locale;
    true
}

/// The app's copy in its language.
pub fn say(id: &str) -> String {
    relay_i18n::translate(locale(), id, &Args::new())
}

/// The app's copy in its language, with values.
pub fn say_with(id: &str, args: &Args) -> String {
    relay_i18n::translate(locale(), id, args)
}

/// The system's preferred languages, most preferred first (`app.getPreferredSystemLanguages`).
pub fn system_languages() -> Vec<String> {
    sys_locale::get_locales().collect()
}
