//! The electron/core/environment case of tests/linux-desktop.test.ts; the rest is in
//! linux_desktop.rs.

use relay_core::environment::{DesktopExecutableOptions, is_claude_desktop_executable};
use relay_core::relay_paths::Platform;

const EXE: &str = "/usr/bin/claude-desktop";
const LIB: &str = "/usr/lib/claude-desktop/claude-desktop";

fn realpath(p: &str) -> String {
    match p {
        "/bin/claude-desktop" | EXE | "/home/me/bin/cd" => LIB.to_owned(),
        other => other.to_owned(),
    }
}

fn options(platform: Platform, desktop: &[&str]) -> DesktopExecutableOptions<'static> {
    DesktopExecutableOptions {
        platform: Some(platform),
        desktop: Some(desktop.iter().map(|d| (*d).to_owned()).collect()),
        realpath: Some(&realpath),
    }
}

#[test]
fn claude_desktop_is_never_taken_for_the_claude_code_cli() {
    let linux = options(Platform::Linux, &[EXE, LIB]);
    // The user's state: /bin is a link to /usr/bin on Arch.
    assert!(is_claude_desktop_executable("/bin/claude-desktop", &linux));
    assert!(is_claude_desktop_executable(LIB, &linux));
    // Renamed, but the same file as Desktop's.
    assert!(is_claude_desktop_executable("/home/me/bin/cd", &linux));
    assert!(is_claude_desktop_executable(
        "/opt/x/claude-desktop",
        &options(Platform::Linux, &[])
    ));
    assert!(!is_claude_desktop_executable(
        "/home/me/.local/bin/claude",
        &linux
    ));
    assert!(!is_claude_desktop_executable(
        "/home/me/.config/Claude/claude-code/2.1.321/ded331c1fbf8/claude",
        &linux
    ));
    let mac = options(
        Platform::MacOs,
        &["/Applications/Claude.app/Contents/MacOS/Claude"],
    );
    assert!(is_claude_desktop_executable(
        "/Applications/Claude.app/Contents/MacOS/Claude",
        &mac
    ));
    assert!(is_claude_desktop_executable(
        "/Users/me/Applications/Claude.app/Contents/MacOS/Claude",
        &options(Platform::MacOs, &[])
    ));
    // Desktop's own downloaded CLI lives in a claude.app too, named claude: it is the CLI.
    assert!(!is_claude_desktop_executable(
        "/Users/me/Library/Application Support/Claude/claude-code/2.1.309/b/claude.app/Contents/MacOS/claude",
        &mac
    ));
    assert!(!is_claude_desktop_executable(
        "/opt/homebrew/bin/claude",
        &mac
    ));
    assert!(is_claude_desktop_executable(
        "C:\\Users\\me\\AppData\\Local\\Programs\\Claude\\Claude.exe",
        &options(Platform::Windows, &[])
    ));
    assert!(!is_claude_desktop_executable(
        "C:\\Users\\me\\.local\\bin\\claude.exe",
        &options(Platform::Windows, &[])
    ));
}
