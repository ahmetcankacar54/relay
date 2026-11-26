//! Port of `electron/core/appearance.ts`.

use crate::shared::types::Appearance;

/// The shell's window theme source (Electron's `nativeTheme.themeSource`) for the saved
/// appearance: the same three values.
pub fn theme_source(appearance: Appearance) -> Appearance {
    appearance
}
