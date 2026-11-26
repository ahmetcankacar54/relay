//! Errors no code caught (port of electron/main/errors.ts): appended to
//! `<logs>/main-errors.log` with the time, each line redacted, for a bug report.

use std::io::Write;
use std::path::PathBuf;

use relay_core::redact::redact;

/// The error log is started over once it passes this size.
const MAIN_ERROR_LOG_BYTES: u64 = 1024 * 1024;

fn log_file() -> PathBuf {
    crate::host::logs_dir().join("main-errors.log")
}

/// An error no code caught, appended to the log. Relay keeps running; nowhere to write it and
/// it is dropped, never raised again.
pub fn record_main_error(kind: &str, error: &str) {
    let file = log_file();
    let lines: Vec<String> = error.lines().map(|line| redact(line, 500)).collect();
    let _ = (|| -> std::io::Result<()> {
        if let Some(dir) = file.parent() {
            relay_core::fs_util::create_private_dir_all(dir)?;
        }
        if std::fs::metadata(&file).is_ok_and(|meta| meta.len() > MAIN_ERROR_LOG_BYTES) {
            std::fs::OpenOptions::new()
                .write(true)
                .truncate(true)
                .open(&file)?;
        }
        let mut options = std::fs::OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let at = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ");
        writeln!(options.open(&file)?, "{at} {kind} {}", lines.join("\n  "))
    })();
}

/// Records every panic, from now until Relay quits (Node's `uncaughtException`).
pub fn install_process_error_handlers() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        record_main_error("panic", &info.to_string());
        previous(info);
    }));
}
