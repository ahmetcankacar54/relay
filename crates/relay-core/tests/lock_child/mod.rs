//! Lock holders in their own processes for the lock tests (the port of `tests/lock-child.ts` and
//! its fixtures): the test binary runs itself with only the ignored `lock_child::child` test,
//! which takes the lock, prints "ready", and holds it.

#![allow(dead_code)]

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

use relay_core::process_lock::{LockBy, ProcessLock};
use relay_core::profile_lock::{ProfileLockKind, acquire_profile_lock};

/// A child process, killed when dropped.
pub struct Child(std::process::Child);

impl Child {
    pub fn pid(&self) -> i64 {
        i64::from(self.0.id())
    }

    /// Waits for the child to exit on its own.
    pub fn exited(mut self) {
        let _ = self.0.wait();
    }
}

impl Drop for Child {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Runs a holder in its own process and returns once it printed "ready".
pub fn child_ready(role: &str, args: &[&str]) -> Child {
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["lock_child::child", "--exact", "--ignored", "--nocapture"])
        .env("RELAY_TEST_CHILD", role)
        .env(
            "RELAY_TEST_CHILD_ARGS",
            serde_json::to_string(args).unwrap(),
        )
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let mut stdout = child.stdout.take().unwrap();
    let mut out = Vec::new();
    let mut byte = [0u8; 1];
    while !String::from_utf8_lossy(&out).contains("ready") {
        match stdout.read(&mut byte) {
            Ok(1) => out.push(byte[0]),
            _ => {
                let status = child.wait();
                panic!("child exited {status:?}: {}", String::from_utf8_lossy(&out));
            }
        }
    }
    Child(child)
}

/// Holds a ProcessLock: `[file, kind, by, releaseMs]`.
pub fn hold_in_child(file: &Path, kind: &str, by: &str, release_ms: u64) -> Child {
    child_ready(
        "process-lock",
        &[file.to_str().unwrap(), kind, by, &release_ms.to_string()],
    )
}

/// Holds a profile lock: `[locks, account, kind]`.
pub fn hold_profile(locks: &Path, account: &str, kind: &str) -> Child {
    child_ready("profile-lock", &[locks.to_str().unwrap(), account, kind])
}

/// Says "ready" to the parent, then holds until killed.
fn ready_then_hold() -> ! {
    ready();
    loop {
        std::thread::sleep(Duration::from_secs(1));
    }
}

fn ready() {
    println!("ready");
}

#[test]
#[ignore = "a lock holder the lock tests run in its own process"]
fn child() {
    let Ok(role) = std::env::var("RELAY_TEST_CHILD") else {
        return;
    };
    let args: Vec<String> =
        serde_json::from_str(&std::env::var("RELAY_TEST_CHILD_ARGS").unwrap()).unwrap();
    match role.as_str() {
        "process-lock" => {
            let by = if args[2] == "app" {
                LockBy::App
            } else {
                LockBy::Cli
            };
            let lock = ProcessLock::new(&args[0], by);
            lock.try_acquire(&args[1]).unwrap();
            let ms: u64 = args[3].parse().unwrap_or(0);
            if ms == 0 {
                ready_then_hold()
            }
            ready();
            std::thread::sleep(Duration::from_millis(ms));
            lock.release();
            std::process::exit(0)
        }
        "profile-lock" => {
            let kind = if args[2] == "exclusive" {
                ProfileLockKind::Exclusive
            } else {
                ProfileLockKind::Shared
            };
            // Held until the process is killed, as the TS fixture never releases it.
            let _guard = acquire_profile_lock(Path::new(&args[0]), &args[1], kind).unwrap();
            ready_then_hold()
        }
        other => panic!("unknown child role {other}"),
    }
}
