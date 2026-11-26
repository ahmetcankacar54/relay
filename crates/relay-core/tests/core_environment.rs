//! The electron/core/environment cases of tests/core.test.ts; the rest of that file belongs to
//! other ports.

use relay_core::environment::{Env, profile_environment, supports_desktop};
use relay_core::relay_paths::Platform;

#[test]
fn ambient_credentials_and_alternate_routing_cannot_leak_into_another_account() {
    let source: Env = [
        ("PATH", "/bin"),
        ("HOME", "/home/you"),
        ("ANTHROPIC_API_KEY", "secret"),
        ("ANTHROPIC_AUTH_TOKEN", "secret"),
        ("ANTHROPIC_BASE_URL", "https://wrong.example"),
        ("ANTHROPIC_PROFILE", "work"),
        ("CLAUDE_CODE_OAUTH_TOKEN", "secret"),
        ("CLAUDE_CODE_USE_BEDROCK", "1"),
        ("CLAUDECODE", "1"),
        ("NODE_OPTIONS", "--require evil.js"),
        ("RELAY_DEV_URL", "http://dev"),
        ("ELECTRON_RUN_AS_NODE", "1"),
        ("CLAUDE_CODE_GIT_BASH_PATH", "C:/Git/bash.exe"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v.to_owned()))
    .collect();
    let env = profile_environment("/test/profile", &source);
    assert_eq!(env["CLAUDE_CONFIG_DIR"], "/test/profile");
    assert_eq!(env["PATH"], "/bin");
    assert_eq!(env["CLAUDE_CODE_GIT_BASH_PATH"], "C:/Git/bash.exe");
    assert!(!env.values().any(|v| v == "secret"));
    assert!(!env.contains_key("ANTHROPIC_BASE_URL"));
    assert!(!env.contains_key("NODE_OPTIONS"));
}

#[test]
fn desktop_requires_a_supported_version_and_platform() {
    assert!(!supports_desktop(
        "2.1.284 (Claude Code)",
        Platform::MacOs,
        "arm64"
    ));
    assert!(supports_desktop(
        "2.1.296 (Claude Code)",
        Platform::MacOs,
        "arm64"
    ));
    assert!(supports_desktop("2.1.296", Platform::Windows, "x64"));
    assert!(!supports_desktop("2.1.296", Platform::Windows, "arm64"));
    assert!(!supports_desktop("2.1.296", Platform::Linux, "x64"));
    assert!(!supports_desktop("unknown", Platform::MacOs, "arm64"));
}
