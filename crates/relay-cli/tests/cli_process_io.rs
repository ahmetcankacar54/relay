//! Port of the CLI case of `tests/cli-process-io.test.ts`; its `runDetached` cases are
//! relay-core's (`crates/relay-core/tests/cli_process_io.rs`).

use std::io::Read;
use std::process::{Command, Stdio};

/// The TS writes through streams that fail with EIO; here the built `relay` writes its help to
/// a pipe whose reader has gone, and must end normally instead of dying on the failed write.
#[test]
fn a_terminal_that_hangs_up_mid_operation_cannot_crash_the_cli_through_a_failed_write() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_relay"))
        .arg("help")
        .env("RELAY_LANG", "en")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    // Nobody reads stdout any more.
    drop(child.stdout.take());
    let mut stderr = String::new();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut stderr)
        .unwrap();
    let status = child.wait().unwrap();
    assert_eq!(status.code(), Some(0), "{stderr}");
    assert!(!stderr.contains("panicked"), "{stderr}");
}
