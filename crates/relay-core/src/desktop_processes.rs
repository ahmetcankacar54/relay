//! Port of `electron/core/desktop-processes.ts`: reading Claude Desktop's process listing.

use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use regex::Regex;

/// The listing could not be read: never "Claude is not running".
pub const PROCESS_LIST_UNREADABLE: &str = "The process list could not be read.";

/// An error with the message the TS throws; the listings' errors carry their own text.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct ProcessError(pub String);

impl ProcessError {
    pub fn new(message: impl Into<String>) -> ProcessError {
        ProcessError(message.into())
    }
}

static PID_LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*(\d+)\s+(.+)$").unwrap());
static LISTING_ROW: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^\s*\d+\s+\S").unwrap());
static ETIME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:(?:(\d+)-)?(\d{2}):)?(\d{2}):(\d{2})$").unwrap());

/// `^\s*(\d+)\s+(.+)$`, a line of `ps -axo pid=,comm=`.
pub(crate) fn pid_line(line: &str) -> Option<(i64, &str)> {
    let captures = PID_LINE.captures(line)?;
    let pid = captures.get(1)?.as_str().parse().ok()?;
    Some((pid, captures.get(2)?.as_str()))
}

/// A real `ps -axo pid=,comm=` listing always holds launchd. An empty or unreadable one means the
/// lookup failed (its output was cut short, say), not that Claude is closed.
pub fn assert_process_listing(stdout: &str) -> Result<(), ProcessError> {
    if LISTING_ROW.is_match(stdout) {
        Ok(())
    } else {
        Err(ProcessError::new(PROCESS_LIST_UNREADABLE))
    }
}

/// Runs `attempt`, and once more after `wait_ms` if it fails; the second failure is reported.
pub fn retry_once<T, E>(
    mut attempt: impl FnMut() -> Result<T, E>,
    wait_ms: u64,
    sleep: &dyn Fn(u64),
) -> Result<T, E> {
    match attempt() {
        Ok(value) => Ok(value),
        Err(_) => {
            sleep(wait_ms);
            attempt()
        }
    }
}

/// The real sleep `retry_once` and the hosts default to.
pub fn sleep_ms(ms: u64) {
    std::thread::sleep(Duration::from_millis(ms));
}

/// The bundle prefix (`…/Claude.app/`) of a macOS executable; None outside a bundle.
pub(crate) fn mac_bundle(executable: &str) -> Option<&str> {
    executable.find(".app/").map(|at| &executable[..at + 5])
}

/// Claude Desktop's pids in a `ps -axo pid=,comm=` listing. Chrome owns the native messaging
/// host: it can outlive Claude's windows and must not make a clean shutdown look like a running
/// app.
pub fn mac_desktop_pids(stdout: &str, executable: &str) -> Vec<i64> {
    let Some(bundle) = mac_bundle(executable) else {
        return Vec::new();
    };
    let browser_host = format!("{bundle}Contents/Helpers/chrome-native-host");
    stdout
        .split('\n')
        .filter_map(pid_line)
        .filter(|(_, command)| {
            *command != browser_host && (*command == executable || command.starts_with(bundle))
        })
        .map(|(pid, _)| pid)
        .collect()
}

/// The pid of Claude's main process in a `ps -axo pid=,comm=` listing: the one running the app's
/// executable itself, not a helper. None when there is none, or more than one.
pub fn mac_main_pid(stdout: &str, executable: &str) -> Option<i64> {
    let pids: Vec<i64> = stdout
        .split('\n')
        .filter_map(pid_line)
        .filter(|(_, command)| *command == executable)
        .map(|(pid, _)| pid)
        .collect();
    (pids.len() == 1).then(|| pids[0])
}

/// `ps -o etime=`, `[[dd-]hh:]mm:ss`, in milliseconds; None when it is not that.
pub fn parse_etime(text: &str) -> Option<i64> {
    let captures = ETIME.captures(text.trim())?;
    let part = |i: usize| -> i64 {
        captures.get(i).map_or(0, |m| {
            m.as_str()
                .parse::<i64>()
                .unwrap_or(i64::MAX / 1_000_000_000)
        })
    };
    let (days, hours, minutes, seconds) = (part(1), part(2), part(3), part(4));
    if hours > 23 || minutes > 59 || seconds > 59 {
        return None;
    }
    Some((((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000)
}

/// How long a Claude pid seen alive is trusted before the next full listing.
pub const LIVENESS_LISTING_MS: i64 = 60_000;

/// A full listing of the main Claude: its pids and its main pid.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ClaudeListing {
    pub pids: Vec<i64>,
    pub main: Option<i64>,
}

/// What `ClaudeLiveness` reads.
pub struct LivenessDeps {
    /// A full listing; fails when the listing fails or comes back empty.
    pub list: Box<dyn Fn() -> Result<ClaudeListing, ProcessError> + Send + Sync>,
    /// `process.kill(pid, 0)`: the pid exists.
    pub alive: Box<dyn Fn(i64) -> bool + Send + Sync>,
    pub now: Box<dyn Fn() -> i64 + Send + Sync>,
}

/// Whether Claude runs, with fewer full process listings. Every listing remembers Claude's main
/// pid (else its first one). For display, `seems_running` answers from that pid while it is alive
/// and the listing is under a minute old; it lists again when no pid is known, the pid is gone or
/// the minute is over. Quits, launches and writes use `running` and `pids`, which always list.
pub struct ClaudeLiveness {
    deps: LivenessDeps,
    known: Mutex<Option<(i64, i64)>>,
}

impl ClaudeLiveness {
    pub fn new(deps: LivenessDeps) -> ClaudeLiveness {
        ClaudeLiveness {
            deps,
            known: Mutex::new(None),
        }
    }

    pub fn pids(&self) -> Result<Vec<i64>, ProcessError> {
        let ClaudeListing { pids, main } = (self.deps.list)()?;
        let pid = main.or_else(|| pids.first().copied());
        *self.known.lock().unwrap_or_else(|e| e.into_inner()) =
            pid.map(|pid| (pid, (self.deps.now)()));
        Ok(pids)
    }

    pub fn running(&self) -> Result<bool, ProcessError> {
        Ok(!self.pids()?.is_empty())
    }

    /// For display only: may still say running for a pid reused within the minute.
    pub fn seems_running(&self) -> Result<bool, ProcessError> {
        let known = *self.known.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((pid, at)) = known
            && (self.deps.now)() - at < LIVENESS_LISTING_MS
            && (self.deps.alive)(pid)
        {
            return Ok(true);
        }
        self.running()
    }
}

/// `process.kill(pid, 0)` as a test: a pid that exists but is not ours still counts.
#[cfg(unix)]
pub fn pid_alive(pid: i64) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    // SAFETY: signal 0 only checks that the process exists and may be signalled.
    if unsafe { libc::kill(pid, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// `process.kill(pid, 0)` as a test: whether a process with that id exists.
#[cfg(not(unix))]
pub fn pid_alive(pid: i64) -> bool {
    let Ok(pid) = u32::try_from(pid) else {
        return false;
    };
    let mut system = sysinfo::System::new();
    let target = sysinfo::Pid::from_u32(pid);
    system.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[target]), true);
    system.process(target).is_some()
}

/// `process.kill(pid, "SIGTERM")`; an error when the process is gone or not ours.
#[cfg(unix)]
pub fn kill_term(pid: i64) -> std::io::Result<()> {
    let pid =
        libc::pid_t::try_from(pid).map_err(|_| std::io::Error::from_raw_os_error(libc::ESRCH))?;
    // SAFETY: plain kill(2) on a pid.
    if unsafe { libc::kill(pid, libc::SIGTERM) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// `process.kill(pid, "SIGTERM")`; Windows ends the process outright, as Node does there.
#[cfg(not(unix))]
pub fn kill_term(pid: i64) -> std::io::Result<()> {
    let pid = u32::try_from(pid).map_err(|_| std::io::Error::other("ESRCH"))?;
    let mut system = sysinfo::System::new();
    let target = sysinfo::Pid::from_u32(pid);
    system.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[target]), true);
    match system.process(target) {
        Some(process) if process.kill() => Ok(()),
        _ => Err(std::io::Error::other("ESRCH")),
    }
}
