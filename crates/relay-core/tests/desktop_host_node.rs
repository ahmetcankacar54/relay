//! Port of tests/desktop-host-node.test.ts.

use std::fs;

use relay_core::desktop_host_node::claude_executable;

#[test]
fn claude_executable_finds_the_first_claude_app_whose_executable_exists() {
    let dir = tempfile::Builder::new()
        .prefix("relay-claude-app-")
        .tempdir()
        .unwrap();
    let app = |name: &str| {
        let bundle = dir.path().join(name).join("Claude.app");
        fs::create_dir_all(bundle.join("Contents").join("MacOS")).unwrap();
        fs::write(bundle.join("Contents").join("MacOS").join("Claude"), "").unwrap();
        bundle
    };
    let first = app("one");
    let second = app("two");
    let missing = dir.path().join("none").join("Claude.app");
    assert_eq!(
        claude_executable(&[missing.clone(), first.clone(), second]),
        Some(first.join("Contents").join("MacOS").join("Claude"))
    );
    assert_eq!(claude_executable(&[missing]), None);
    assert_eq!(claude_executable(&["relative/Claude.app".into()]), None);
}
