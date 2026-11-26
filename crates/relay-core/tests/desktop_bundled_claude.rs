//! Port of tests/desktop-bundled-claude.test.ts (electron/core/environment and cli-diagnostics).

#[path = "common/usage_terminal.rs"]
mod helpers;

use std::ffi::OsString;
use std::path::Path;

use helpers::write_script;
use relay_core::environment::{desktop_bundled_claude, usable_file};
use relay_core::relay_paths::Platform;

fn no_env(_: &str) -> Option<OsString> {
    None
}

/// Desktop's download of Claude Code `version`/`hash` on macOS; `.verified` when it checked out.
fn bundle(home: &Path, version: &str, hash: &str, verified: bool) -> String {
    let dir = home
        .join("Library")
        .join("Application Support")
        .join("Claude")
        .join("claude-code")
        .join(version)
        .join(hash);
    let macos = dir.join("claude.app").join("Contents").join("MacOS");
    std::fs::create_dir_all(&macos).unwrap();
    let executable = macos.join("claude");
    write_script(&executable, "#!/bin/sh\necho '9.9.9 (Claude Code)'\n");
    if verified {
        std::fs::write(dir.join(".verified"), hash).unwrap();
    }
    executable.to_string_lossy().into_owned()
}

#[test]
fn the_claude_app_s_own_claude_code_newest_verified_version_on_macos() {
    let home = tempfile::Builder::new()
        .prefix("relay-bundled-")
        .tempdir()
        .unwrap();
    let home = home.path();
    let mac = |usable: &dyn Fn(&str) -> bool| {
        desktop_bundled_claude(home, Platform::MacOs, usable, &no_env)
    };
    assert_eq!(mac(&usable_file), None);
    bundle(home, "2.1.9", "aaa", true);
    let newest = bundle(home, "2.1.309", "bbb", true);
    // A newer download that has not checked out yet is not used.
    bundle(home, "2.1.400", "ccc", false);
    std::fs::create_dir(
        home.join("Library")
            .join("Application Support")
            .join("Claude")
            .join("claude-code")
            .join("notes"),
    )
    .unwrap();
    assert_eq!(mac(&usable_file), Some(newest));
    // Linux keeps it elsewhere, Windows nowhere Relay knows.
    assert_eq!(
        desktop_bundled_claude(home, Platform::Linux, &usable_file, &no_env),
        None
    );
    assert_eq!(
        desktop_bundled_claude(home, Platform::Windows, &usable_file, &no_env),
        None
    );
    assert_eq!(mac(&|_| false), None);
}

// POSIX paths.
#[cfg(unix)]
#[test]
fn on_linux_config_claude_claude_code_version_hash_claude_newest_verified_first() {
    use relay_core::environment::{ExecutableSource, executable_source};
    let home = tempfile::Builder::new()
        .prefix("relay-bundled-linux-")
        .tempdir()
        .unwrap();
    let home = home.path();
    let linux = |root: &Path, version: &str, hash: &str, verified: bool| {
        let dir = root
            .join("Claude")
            .join("claude-code")
            .join(version)
            .join(hash);
        std::fs::create_dir_all(&dir).unwrap();
        write_script(&dir.join("claude"), "#!/bin/sh\n");
        if verified {
            std::fs::write(dir.join(".verified"), hash).unwrap();
        }
        dir.join("claude").to_string_lossy().into_owned()
    };
    let config = home.join(".config");
    linux(&config, "2.1.308", "f8b3641a8d36", true);
    let newest = linux(&config, "2.1.321", "ded331c1fbf8", true);
    linux(&config, "2.1.400", "ccc", false);
    assert_eq!(
        desktop_bundled_claude(home, Platform::Linux, &usable_file, &no_env),
        Some(newest.clone())
    );
    assert_eq!(
        executable_source(&newest, None),
        ExecutableSource::ClaudeApp
    );
    // $XDG_CONFIG_HOME moves Claude's data folder with it.
    let xdg_root = home.join("xdg");
    let xdg = linux(&xdg_root, "2.1.1", "aaa", true);
    let env = |key: &str| (key == "XDG_CONFIG_HOME").then(|| xdg_root.clone().into_os_string());
    assert_eq!(
        desktop_bundled_claude(home, Platform::Linux, &usable_file, &env),
        Some(xdg)
    );
}

// The TS skips it on Windows (path.sep is "\" there).
#[cfg(unix)]
#[test]
fn where_a_cli_came_from_the_user_s_choice_the_claude_app_or_the_usual_places() {
    use relay_core::environment::{ExecutableSource, executable_source};
    let app = "/Users/me/Library/Application Support/Claude/claude-code/2.1.309/b/claude.app/Contents/MacOS/claude";
    assert_eq!(executable_source(app, None), ExecutableSource::ClaudeApp);
    assert_eq!(executable_source(app, Some(app)), ExecutableSource::Chosen);
    // Claude Desktop chosen as the CLI was set aside: the CLI found instead is not the choice.
    assert_eq!(
        executable_source(app, Some("/bin/claude-desktop")),
        ExecutableSource::ClaudeApp
    );
    assert_eq!(
        executable_source("/Users/me/.local/bin/claude", None),
        ExecutableSource::Path
    );
}

// Needs a POSIX shell: the stand-in is a shell script.
#[cfg(unix)]
#[test]
fn the_diagnosis_reports_the_source_and_still_reads_the_version() {
    use relay_core::cli_diagnostics::diagnose_cli;
    use relay_core::shared::types::DiagnosticsSource;

    let home = tempfile::Builder::new()
        .prefix("relay-bundled-diag-")
        .tempdir()
        .unwrap();
    let home = home.path();
    let executable = bundle(home, "2.1.309", "bbb", true);
    let diagnostics = diagnose_cli(Some(&executable), home);
    assert_eq!(diagnostics.source, Some(DiagnosticsSource::Chosen));
    assert_eq!(diagnostics.version.as_deref(), Some("9.9.9 (Claude Code)"));
}
