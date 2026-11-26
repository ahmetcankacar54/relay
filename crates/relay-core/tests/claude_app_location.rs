//! Port of tests/claude-app-location.test.ts. Skipped: "Settings and the setup checklist offer
//! Choose location, and main keeps the choice" reads UI and main-process source text.

#[cfg(not(windows))]
use std::collections::HashSet;
use std::path::{Path, PathBuf};

use relay_core::desktop_host_node::claude_candidates;
#[cfg(not(windows))]
use relay_core::desktop_host_node::resolve_claude_executable;
use relay_core::relay_paths::Platform;

#[test]
fn linux_looks_in_the_official_and_community_packages_places_and_a_claude_appimage() {
    let candidates = claude_candidates(Platform::Linux, None, Some(Path::new("/home/me")), &|_| {
        None
    });
    assert!(candidates.contains(&"/usr/bin/claude-desktop".to_string()));
    assert!(candidates.contains(&"/home/me/.local/bin/claude-desktop".to_string()));
    assert!(candidates.contains(&"/opt/Claude/claude-desktop".to_string()));
    let apps = [PathBuf::from("/Applications/Claude.app")];
    assert_eq!(
        claude_candidates(Platform::MacOs, Some(&apps), None, &|_| None),
        vec!["/Applications/Claude.app/Contents/MacOS/Claude"]
    );
    let env = |key: &str| (key == "LOCALAPPDATA").then(|| "C:\\L".to_string());
    assert_eq!(
        claude_candidates(Platform::Windows, None, None, &env).len(),
        2
    );
}

// The chosen paths are POSIX paths, absolute only off Windows.
#[cfg(not(windows))]
#[test]
fn a_chosen_location_wins_when_it_exists_a_chosen_claude_app_opens_to_its_executable() {
    let files: HashSet<&str> = [
        "/opt/x/claude-desktop",
        "/usr/bin/claude-desktop",
        "/Apps/Claude.app/Contents/MacOS/Claude",
    ]
    .into();
    let exists = |p: &str| files.contains(p);
    let usual = vec!["/usr/bin/claude-desktop".to_string()];
    assert_eq!(
        resolve_claude_executable(Some("/opt/x/claude-desktop"), &usual, &exists).as_deref(),
        Some("/opt/x/claude-desktop")
    );
    assert_eq!(
        resolve_claude_executable(Some("/Apps/Claude.app"), &[], &exists).as_deref(),
        Some("/Apps/Claude.app/Contents/MacOS/Claude")
    );
    assert_eq!(
        resolve_claude_executable(Some("/gone/claude"), &usual, &exists).as_deref(),
        Some("/usr/bin/claude-desktop")
    );
    assert_eq!(
        resolve_claude_executable(Some("claude-desktop"), &usual, &exists).as_deref(),
        Some("/usr/bin/claude-desktop")
    );
    assert_eq!(resolve_claude_executable(None, &[], &exists), None);
}
