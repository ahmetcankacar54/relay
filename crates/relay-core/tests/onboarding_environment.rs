//! The `supportsDesktop` (electron/core/environment) part of tests/onboarding.test.ts; its
//! shared/cli-version part is in shared_onboarding.rs.

use relay_core::environment::supports_desktop;
use relay_core::relay_paths::Platform;

#[test]
fn the_cli_minimum_is_the_one_the_desktop_check_uses() {
    // The platform gate stays in environment; the version gate is the shared one.
    assert!(supports_desktop("2.1.285", Platform::MacOs, "arm64"));
    assert!(!supports_desktop("2.1.285", Platform::Linux, "x64"));
}
