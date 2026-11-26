//! Port of `electron/core/detached-exec.ts`: `execFile` in a process group of its own.
//!
//! A terminal's Ctrl+C or hang-up goes to its foreground group, so commands Relay runs while
//! Claude is closed and files are swapped (osascript, open, ps) must not be in it: killed half
//! way, they would leave Claude closed.

use std::collections::BTreeMap;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// `execFile`'s default `maxBuffer`, 1 MiB.
pub const DEFAULT_MAX_BUFFER: usize = 1024 * 1024;

/// What a run is given: a timeout, an output cap, and an environment that replaces Relay's own.
#[derive(Debug, Clone, Default)]
pub struct ExecOptions {
    pub timeout: Duration,
    /// Output cap over stdout and stderr together; `DEFAULT_MAX_BUFFER` when unset.
    pub max_buffer: Option<usize>,
    /// The whole environment the command gets; Relay's own when unset.
    pub env: Option<BTreeMap<String, String>>,
}

impl ExecOptions {
    pub fn timeout_ms(ms: u64) -> ExecOptions {
        ExecOptions {
            timeout: Duration::from_millis(ms),
            ..ExecOptions::default()
        }
    }
}

/// A finished run's output.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExecOutput {
    pub stdout: String,
    pub stderr: String,
}

/// What `execFile`'s failure carries: the exit code, a timeout kill, and the output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DetachedExecError {
    pub message: String,
    /// The exit code; None when a signal ended it or it never started.
    pub code: Option<i32>,
    pub killed: bool,
    /// The signal that ended it, by number (`signal_name` gives Node's `SIGKILL`…).
    pub signal: Option<i32>,
    /// Node's error code (`ENOENT`…) when the command could not start.
    pub errno: Option<String>,
    pub stdout: String,
    pub stderr: String,
}

impl std::fmt::Display for DetachedExecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for DetachedExecError {}

/// Decodes output as Node's `setEncoding("utf8")` does over the whole stream: a character split
/// across reads comes back whole, invalid bytes become U+FFFD.
fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// Node's spawn error code for an I/O error.
pub fn errno_code(error: &std::io::Error) -> String {
    match error.kind() {
        std::io::ErrorKind::NotFound => "ENOENT".into(),
        std::io::ErrorKind::PermissionDenied => "EACCES".into(),
        _ => error
            .raw_os_error()
            .map_or_else(|| "EUNKNOWN".into(), |code| format!("E{code}")),
    }
}

/// Node's spawn error message: `spawn <file> ENOENT`.
fn spawn_error(file: &str, error: &std::io::Error) -> DetachedExecError {
    let errno = errno_code(error);
    DetachedExecError {
        message: format!("spawn {file} {errno}"),
        code: None,
        killed: false,
        signal: None,
        errno: Some(errno),
        stdout: String::new(),
        stderr: String::new(),
    }
}

/// Node's name of a signal (`SIGKILL`…).
pub fn signal_name(signal: i32) -> String {
    #[cfg(unix)]
    {
        let name = match signal {
            libc::SIGKILL => "SIGKILL",
            libc::SIGTERM => "SIGTERM",
            libc::SIGINT => "SIGINT",
            libc::SIGHUP => "SIGHUP",
            libc::SIGABRT => "SIGABRT",
            libc::SIGSEGV => "SIGSEGV",
            libc::SIGPIPE => "SIGPIPE",
            _ => return format!("SIG{signal}"),
        };
        name.to_string()
    }
    #[cfg(not(unix))]
    format!("SIG{signal}")
}

#[cfg(unix)]
fn exit_signal(status: &std::process::ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;
    status.signal()
}

#[cfg(not(unix))]
fn exit_signal(_status: &std::process::ExitStatus) -> Option<i32> {
    None
}

/// Runs a command in its own process group. Ok with the output on exit 0; otherwise an error
/// whose message reads like execFile's (`Command failed: …` and the stderr).
pub fn run_detached(
    file: &str,
    args: &[String],
    options: &ExecOptions,
) -> Result<ExecOutput, DetachedExecError> {
    run(file, args, options, true)
}

/// `execFile` in Relay's own process group: what the host uses on Windows.
pub fn run_attached(
    file: &str,
    args: &[String],
    options: &ExecOptions,
) -> Result<ExecOutput, DetachedExecError> {
    run(file, args, options, false)
}

fn run(
    file: &str,
    args: &[String],
    options: &ExecOptions,
    detached: bool,
) -> Result<ExecOutput, DetachedExecError> {
    let limit = options.max_buffer.unwrap_or(DEFAULT_MAX_BUFFER);
    let mut command = Command::new(file);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(env) = &options.env {
        command.env_clear().envs(env);
    }
    #[cfg(unix)]
    if detached {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW (windowsHide), plus a group of its own when detached.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        command.creation_flags(if detached {
            CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP
        } else {
            CREATE_NO_WINDOW
        });
    }
    #[cfg(not(any(unix, windows)))]
    let _ = detached;
    let mut child = command.spawn().map_err(|error| spawn_error(file, &error))?;
    let total = Arc::new(AtomicUsize::new(0));
    let over = Arc::new(AtomicBool::new(false));
    let reader = |stream: Option<Box<dyn Read + Send>>| {
        let total = Arc::clone(&total);
        let over = Arc::clone(&over);
        let buffer = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&buffer);
        let handle = thread::spawn(move || {
            let Some(mut stream) = stream else { return };
            let mut chunk = [0u8; 8192];
            loop {
                match stream.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        sink.lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .extend_from_slice(&chunk[..n]);
                        if total.fetch_add(n, Ordering::SeqCst) + n > limit {
                            over.store(true, Ordering::SeqCst);
                        }
                    }
                }
            }
        });
        (handle, buffer)
    };
    let (out_thread, out_buffer) = reader(
        child
            .stdout
            .take()
            .map(|s| Box::new(s) as Box<dyn Read + Send>),
    );
    let (err_thread, err_buffer) = reader(
        child
            .stderr
            .take()
            .map(|s| Box::new(s) as Box<dyn Read + Send>),
    );
    let deadline = Instant::now() + options.timeout;
    let mut killed = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {}
            Err(_) => break None,
        }
        if !killed && (Instant::now() >= deadline || over.load(Ordering::SeqCst)) {
            killed = true;
            let _ = child.kill();
        }
        thread::sleep(Duration::from_millis(5));
    };
    let _ = out_thread.join();
    let _ = err_thread.join();
    let stdout = text(&out_buffer.lock().unwrap_or_else(|e| e.into_inner()));
    let stderr = text(&err_buffer.lock().unwrap_or_else(|e| e.into_inner()));
    let killed = killed || over.load(Ordering::SeqCst);
    let code = status.and_then(|status| status.code());
    if code == Some(0) && !killed {
        return Ok(ExecOutput { stdout, stderr });
    }
    let line = std::iter::once(file)
        .chain(args.iter().map(String::as_str))
        .collect::<Vec<_>>()
        .join(" ");
    Err(DetachedExecError {
        message: if stderr.is_empty() {
            format!("Command failed: {line}")
        } else {
            format!("Command failed: {line}\n{stderr}")
        },
        code,
        killed,
        signal: status.as_ref().and_then(exit_signal),
        errno: None,
        stdout,
        stderr,
    })
}
