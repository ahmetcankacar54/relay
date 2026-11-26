//! The `shared/cli-version`, `shared/external-links` and `shared/browser-extension` assertions of
//! tests/onboarding.test.ts and tests/linux-browser.test.ts. Their main-source, `supportsDesktop`
//! (electron/core/environment) and browser-system parts belong to other ports.

use relay_core::shared::browser_extension::{BROWSER_APPS, BrowserApp, browser_apps};
use relay_core::shared::cli_version::{
    MIN_CLI_VERSION, USAGE_CLI_VERSION, meets_cli_minimum, reads_usage,
};
use relay_core::shared::external_links::{EXTERNAL_LINKS, is_external_link};

#[test]
fn the_cli_minimum_is_the_one_the_desktop_check_uses() {
    assert_eq!(MIN_CLI_VERSION, "2.1.285");
    assert!(!meets_cli_minimum("2.1.284 (Claude Code)"));
    assert!(meets_cli_minimum("2.1.285 (Claude Code)"));
    assert!(meets_cli_minimum("2.2.0"));
    assert!(meets_cli_minimum("3.0.0"));
    assert!(!meets_cli_minimum("1.9.999"));
    assert!(!meets_cli_minimum("unknown"));
}

#[test]
fn reading_limits_needs_a_newer_cli_the_one_the_usage_refresher_enforces() {
    assert_eq!(USAGE_CLI_VERSION, "2.1.296");
    assert!(!reads_usage("2.1.295 (Claude Code)"));
    assert!(reads_usage("2.1.296 (Claude Code)"));
    assert!(reads_usage("2.2.0"));
    assert!(!reads_usage("2.0.999"));
    assert!(!reads_usage("1.9.999"));
    assert!(!reads_usage("unknown"));
    // The first a.b.c run counts, wherever it is.
    assert!(reads_usage("claude v2.1.300-beta"));
    assert!(reads_usage("1.2 then 2.1.300"));
    assert!(!reads_usage("1.2 then 2.1.200"));
}

#[test]
fn only_the_two_first_run_pages_the_providers_terms_and_the_full_disk_access_pane_may_open_outside_relay()
 {
    assert_eq!(
        EXTERNAL_LINKS,
        [
            ("claudeDownload", "https://claude.ai/download"),
            (
                "cliSetup",
                "https://docs.anthropic.com/en/docs/claude-code/setup"
            ),
            (
                "claudeTerms",
                "https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use"
            ),
            ("antigravityTerms", "https://antigravity.google/docs/faq"),
            ("anthropicAup", "https://www.anthropic.com/legal/aup"),
            (
                "antigravityServiceTerms",
                "https://antigravity.google/terms"
            ),
            (
                "openaiSignIn",
                "https://help.openai.com/en/articles/20001542"
            ),
            (
                "githubTerms",
                "https://docs.github.com/en/site-policy/github-terms/github-terms-of-service"
            ),
            ("geminiCliFaq", "https://geminicli.com/docs/resources/faq/"),
            ("cursorTerms", "https://cursor.com/terms-of-service"),
            (
                "fullDiskAccess",
                "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
            ),
        ]
    );
    assert!(is_external_link("https://claude.ai/download"));
    assert!(is_external_link(
        "https://docs.anthropic.com/en/docs/claude-code/setup"
    ));
    assert!(!is_external_link("https://claude.ai/download?x=1"));
    assert!(!is_external_link("https://example.com"));
    assert!(!is_external_link("file:///etc/passwd"));
}

#[test]
fn linux_looks_in_the_browsers_with_a_linux_build_only() {
    assert_eq!(
        browser_apps(Some("linux"))
            .into_iter()
            .map(BrowserApp::as_str)
            .collect::<Vec<_>>(),
        [
            "chrome",
            "brave",
            "edge",
            "chromium",
            "vivaldi",
            "chrome-beta",
            "chrome-dev"
        ]
    );
    assert_eq!(browser_apps(Some("darwin")).len(), 11);
    assert_eq!(browser_apps(None), BROWSER_APPS);
}
