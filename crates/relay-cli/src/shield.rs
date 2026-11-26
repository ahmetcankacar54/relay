//! Port of `cli/src/shield.ts`.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::i18n::T;
use crate::io::CliIo;

/// Runs an operation that must not stop half-way (Claude is closed and files are being
/// swapped): Ctrl+C, SIGTERM and SIGHUP are held off until it ends, with one line saying so.
pub fn shielded<R>(io: &CliIo, t: T, run: impl FnOnce() -> R) -> R {
    let told = Arc::new(AtomicBool::new(false));
    let stderr = io.stderr.clone();
    let line = t.t("shield.aClaudeAppOperationIsRunning");
    io.signal(Some(Arc::new(move |_| {
        if !told.swap(true, Ordering::SeqCst) {
            stderr(&line);
        }
    })));
    struct Reset<'a>(&'a CliIo);
    impl Drop for Reset<'_> {
        fn drop(&mut self) {
            self.0.signal(None);
        }
    }
    let _reset = Reset(io);
    run()
}
