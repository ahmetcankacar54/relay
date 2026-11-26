//! Port of tests/switch-diagnostics.test.ts.

use std::fs;
use std::path::PathBuf;

use relay_core::desktop::LaunchOptions;
use relay_core::desktop_host_node::launch_args;
use relay_core::shared::types::{ClaudeLaunchChoice, ClaudeLaunchPatch};
use relay_core::switch_diagnostics::SwitchDiagnostics;

fn folder() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::Builder::new()
        .prefix("relay-switch-diagnostics-")
        .tempdir()
        .unwrap();
    let folder = dir.path().join("switch-diagnostics");
    (dir, folder)
}

#[test]
fn the_launch_choice_starts_off_keeps_what_a_change_names_and_outlives_relay() {
    let (_tmp, dir) = folder();
    let mut first = SwitchDiagnostics::new(&dir);
    assert_eq!(first.current(), ClaudeLaunchChoice { quic_off: false });
    assert_eq!(
        first
            .set(ClaudeLaunchPatch {
                quic_off: Some(true)
            })
            .unwrap(),
        ClaudeLaunchChoice { quic_off: true }
    );
    // Read again as Relay reads it at its next start; only the owner may read it.
    assert_eq!(
        SwitchDiagnostics::new(&dir).current(),
        ClaudeLaunchChoice { quic_off: true }
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(dir.join("settings.json"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    // An unreadable file is the default, never a failure.
    fs::write(dir.join("settings.json"), "{not json").unwrap();
    assert_eq!(
        SwitchDiagnostics::new(&dir).current(),
        ClaudeLaunchChoice { quic_off: false }
    );
}

#[test]
fn a_net_log_an_older_relay_turned_on_is_ignored() {
    let (_tmp, dir) = folder();
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("settings.json"),
        r#"{"netLog":true,"quicOff":true}"#,
    )
    .unwrap();
    assert_eq!(
        SwitchDiagnostics::new(&dir).current(),
        ClaudeLaunchChoice { quic_off: true }
    );
}

#[test]
fn claudes_switches_no_http3_and_never_a_debugging_or_network_override_switch() {
    assert_eq!(launch_args(None), Vec::<String>::new());
    let off = Some(LaunchOptions { quic_off: true });
    assert_eq!(launch_args(off), vec!["--disable-quic"]);
    for arg in launch_args(off) {
        for bad in [
            "log-net-log",
            "net-log-capture-mode",
            "remote-debugging",
            "host-rules",
        ] {
            assert!(!arg.contains(bad));
        }
    }
}
