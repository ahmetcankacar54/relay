//! Helpers for the P4Services ports: polling waits and shell-script CLI stand-ins.
#![allow(dead_code)]

use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

/// Polls `check` every 20 ms for up to 10 s; panics when it never holds.
pub fn until(mut check: impl FnMut() -> bool) {
    for _ in 0..500 {
        if check() {
            return;
        }
        thread::sleep(Duration::from_millis(20));
    }
    panic!("Timed out");
}

/// Writes an executable `/bin/sh` script named `name` in `dir`.
pub fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
    let file = dir.join(name);
    fs::write(&file, format!("#!/bin/sh\n{body}\n")).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&file, fs::Permissions::from_mode(0o700)).unwrap();
    }
    file
}

pub fn sleep_ms(ms: u64) {
    thread::sleep(Duration::from_millis(ms));
}
