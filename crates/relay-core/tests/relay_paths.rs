//! Port of `tests/relay-paths.test.ts`.

// The POSIX cases are skipped on Windows, as in the TS, leaving their helpers unused there.
#![cfg_attr(windows, allow(unused_imports, dead_code))]

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use relay_core::relay_paths::{Platform, app_data_root, relay_paths_with};

/// An environment holding only `pairs`.
fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<OsString> {
    let pairs: Vec<(String, String)> = pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    move |key| {
        pairs
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| OsString::from(v))
    }
}

fn p(text: &str) -> PathBuf {
    PathBuf::from(text)
}

// macOS only: the folders the relay CLI uses; POSIX paths, so skipped on Windows as in the TS.
#[cfg(not(windows))]
#[test]
fn paths_default_under_application_support_and_honour_overrides() {
    let x = relay_paths_with(&env(&[]), Path::new("/Users/x"), Platform::MacOs);
    assert_eq!(x.data, p("/Users/x/Library/Application Support/Relay"));
    assert_eq!(x.claude, p("/Users/x/Library/Application Support/Claude"));
    assert_eq!(
        x.claude_apps,
        vec![
            p("/Applications/Claude.app"),
            p("/Users/x/Applications/Claude.app")
        ]
    );
    assert_eq!(
        x.vault,
        p("/Users/x/Library/Application Support/Relay/desktop-vault")
    );
    assert_eq!(
        x.profiles,
        p("/Users/x/Library/Application Support/Relay/profiles")
    );
    assert_eq!(
        x.cli_operations,
        p("/Users/x/Library/Application Support/Relay/cli-operations")
    );
    let o = relay_paths_with(
        &env(&[
            ("RELAY_HOME", "/t/r"),
            ("RELAY_CLAUDE_DIR", "/t/c"),
            ("RELAY_CLAUDE_APP", "/t/Claude.app"),
        ]),
        Path::new("/Users/x"),
        Platform::MacOs,
    );
    assert_eq!(
        (o.data, o.claude, o.claude_apps, o.locks),
        (
            p("/t/r"),
            p("/t/c"),
            vec![p("/t/Claude.app")],
            p("/t/r/profiles/.locks")
        )
    );
}

#[cfg(not(windows))]
#[test]
fn relative_overrides_are_ignored() {
    let x = relay_paths_with(
        &env(&[("RELAY_HOME", "relative/dir")]),
        Path::new("/Users/x"),
        Platform::MacOs,
    );
    assert_eq!(x.data, p("/Users/x/Library/Application Support/Relay"));
}

#[cfg(not(windows))]
#[test]
fn linux_keeps_relay_and_claude_in_the_xdg_config_folder_as_electron_does() {
    let x = relay_paths_with(&env(&[]), Path::new("/home/x"), Platform::Linux);
    assert_eq!(
        (x.data, x.claude, x.claude_apps, x.vault),
        (
            p("/home/x/.config/Relay"),
            p("/home/x/.config/Claude"),
            vec![],
            p("/home/x/.config/Relay/desktop-vault")
        )
    );
    let xdg = relay_paths_with(
        &env(&[("XDG_CONFIG_HOME", "/cfg/")]),
        Path::new("/home/x"),
        Platform::Linux,
    );
    assert_eq!((xdg.data, xdg.claude), (p("/cfg/Relay"), p("/cfg/Claude")));
    // A relative XDG_CONFIG_HOME is invalid by the spec and ignored; overrides still win.
    assert_eq!(
        relay_paths_with(
            &env(&[("XDG_CONFIG_HOME", "cfg")]),
            Path::new("/home/x"),
            Platform::Linux
        )
        .data,
        p("/home/x/.config/Relay")
    );
    assert_eq!(
        relay_paths_with(
            &env(&[("XDG_CONFIG_HOME", "/cfg"), ("RELAY_HOME", "/t/r")]),
            Path::new("/home/x"),
            Platform::Linux
        )
        .data,
        p("/t/r")
    );
}

#[test]
fn windows_keeps_them_in_appdata() {
    assert_eq!(
        app_data_root(
            Platform::Windows,
            Path::new("C:\\Users\\x"),
            &env(&[("APPDATA", "D:\\Roaming")])
        ),
        p("D:\\Roaming")
    );
    assert_eq!(
        app_data_root(Platform::Windows, Path::new("C:\\Users\\x"), &env(&[])),
        p("C:\\Users\\x\\AppData\\Roaming")
    );
}

// Overrides are resolved, as `path.resolve` does: `..` and a trailing separator fold away.
#[cfg(not(windows))]
#[test]
fn absolute_overrides_are_resolved() {
    let x = relay_paths_with(
        &env(&[("RELAY_HOME", "/t/x/../r/"), ("RELAY_CLAUDE_DIR", "")]),
        Path::new("/Users/x"),
        Platform::MacOs,
    );
    assert_eq!(x.data, p("/t/r"));
    assert_eq!(x.claude, p("/Users/x/Library/Application Support/Claude"));
}
