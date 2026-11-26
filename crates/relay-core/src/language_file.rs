//! Port of `electron/core/language-file.ts`.

use std::fs;
use std::io::{self, Write};
use std::path::Path;

use relay_i18n::{LanguagePref, parse_pref};

use crate::fs_util::create_new_private;

/// The app's language choice, in its own file beside state.json (`language.json`, `{ "pref": … }`),
/// so a language never changes the registry's schema that older builds and the CLI read.
pub const LANGUAGE_FILE: &str = "language.json";

/// The text a choice is saved as: "system" or the locale id.
fn pref_text(pref: LanguagePref) -> &'static str {
    match pref {
        LanguagePref::System => "system",
        LanguagePref::Locale(locale) => locale.as_str(),
    }
}

/// The saved choice; None when the file is missing or holds no valid choice.
pub fn read_language_pref(dir: &Path) -> Option<LanguagePref> {
    let text = fs::read_to_string(dir.join(LANGUAGE_FILE)).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    parse_pref(value.get("pref")?.as_str()?)
}

/// Saves the choice atomically, readable only by the user.
pub fn write_language_pref(dir: &Path, pref: LanguagePref) -> io::Result<()> {
    let file = dir.join(LANGUAGE_FILE);
    let mut tmp = file.clone().into_os_string();
    tmp.push(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let tmp = std::path::PathBuf::from(tmp);
    let result = (|| {
        let mut fd = create_new_private(&tmp)?;
        let body = serde_json::json!({ "pref": pref_text(pref) });
        fd.write_all(format!("{body}\n").as_bytes())?;
        fd.sync_all()?;
        drop(fd);
        fs::rename(&tmp, &file)
    })();
    let _ = fs::remove_file(&tmp);
    result
}

/// The saved choice, or on first start the migration's: installs from before the setting saw
/// Turkish, so they keep it; new ones follow the system. The migration's choice is saved.
pub fn load_language_pref(dir: &Path, has_accounts: bool) -> LanguagePref {
    if let Some(saved) = read_language_pref(dir) {
        return saved;
    }
    let pref = if has_accounts {
        LanguagePref::Locale(relay_i18n::Locale::Tr)
    } else {
        LanguagePref::System
    };
    // An unwritable folder still gets the language for this run; the next start tries again.
    let _ = write_language_pref(dir, pref);
    pref
}
