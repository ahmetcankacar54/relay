//! Port of `cli/src/statusline.ts`: `relay statusline` without the rest of the CLI. It reads
//! two small files and stdin; it never opens the account list, the vault, the Keychain or the
//! network, so `main` runs it before anything else is set up.

use std::io::{IsTerminal, Read};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use relay_core::relay_paths::{Platform, relay_paths_with};
use relay_core::shared::statusline::{
    STATUSLINE_FILE, StatuslineRender, StatuslineSnapshot, StatuslineStyle, claude_sign_in,
    parse_statusline_input, parse_statusline_snapshot, render_statusline,
};

use crate::io::{Env, env_get};

/// How long stdin may stay open before the line is drawn without it.
pub const STDIN_WAIT_MS: u64 = 250;

const fn codes(style: StatuslineStyle) -> (u8, u8) {
    match style {
        StatuslineStyle::Bold => (1, 22),
        StatuslineStyle::Dim => (2, 22),
        StatuslineStyle::Green => (32, 39),
        StatuslineStyle::Yellow => (33, 39),
        StatuslineStyle::Red => (31, 39),
    }
}

/// Claude Code's JSON on this process's stdin: nothing from a terminal, and whatever came once
/// `wait` passed. A stdin left open never keeps the process alive: the reader thread is left
/// behind and the process exits without it.
pub fn read_stdin(wait: Duration) -> String {
    let stdin = std::io::stdin();
    if stdin.is_terminal() {
        return String::new();
    }
    let chunks = Arc::new(Mutex::new(Vec::<u8>::new()));
    let (done, ended) = mpsc::channel::<()>();
    let sink = chunks.clone();
    let spawned = std::thread::Builder::new().spawn(move || {
        let mut stdin = std::io::stdin().lock();
        let mut buffer = [0u8; 8192];
        loop {
            match stdin.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(n) => sink
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .extend_from_slice(&buffer[..n]),
            }
        }
        let _ = done.send(());
    });
    if spawned.is_ok() {
        let _ = ended.recv_timeout(wait);
    }
    let bytes = std::mem::take(&mut *chunks.lock().unwrap_or_else(|e| e.into_inner()));
    String::from_utf8_lossy(&bytes).into_owned()
}

fn read_text(file: &Path) -> Option<String> {
    let bytes = std::fs::read(file).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// The snapshot Relay.app wrote in its data folder (as `relayPaths` finds it on this platform,
/// or RELAY_HOME), or `None` when there is none yet.
pub fn read_statusline_snapshot(
    env: &dyn Fn(&str) -> Option<std::ffi::OsString>,
    home: &Path,
    platform: Platform,
) -> Option<StatuslineSnapshot> {
    let data = relay_paths_with(env, home, platform).data;
    parse_statusline_snapshot(read_text(&data.join(STATUSLINE_FILE)).as_deref())
}

/// [`read_statusline_snapshot`] over a CLI environment.
pub fn read_statusline_snapshot_in(env: &Env, home: &Path) -> Option<StatuslineSnapshot> {
    read_statusline_snapshot(
        &|name| env_get(env, name).map(Into::into),
        home,
        Platform::current(),
    )
}

/// One run of the line.
pub struct StatuslineRun<'a> {
    /// Claude Code's stdin JSON.
    pub stdin: &'a str,
    /// `CLAUDE_CONFIG_DIR`, as the environment has it.
    pub config_dir: Option<&'a str>,
    pub home: PathBuf,
    pub now: i64,
    pub color: bool,
}

/// The status line for this session; empty when there is nothing to show for it.
pub fn statusline_text(snapshot: &StatuslineSnapshot, run: &StatuslineRun<'_>) -> String {
    let config_dir = run.config_dir.filter(|d| !d.is_empty());
    let input = parse_statusline_input(Some(run.stdin));
    let color = run.color;
    let paint = move |style: StatuslineStyle, text: &str| {
        if color {
            let (on, off) = codes(style);
            format!("\x1b[{on}m{text}\x1b[{off}m")
        } else {
            text.to_owned()
        }
    };
    // Claude Code keeps its sign-in's name in `.claude.json`: in CLAUDE_CONFIG_DIR, else the home folder.
    let folder = match config_dir {
        Some(dir) if Path::new(dir).is_absolute() => PathBuf::from(dir),
        _ => run.home.clone(),
    };
    render_statusline(StatuslineRender {
        snapshot,
        input: &input,
        config_dir,
        sign_in: Box::new(move || {
            claude_sign_in(read_text(&folder.join(".claude.json")).as_deref())
        }),
        now: run.now as f64,
        paint: &paint,
    })
}

/// Colors: `--color`, or stdout is a terminal; never with NO_COLOR or `--no-color`.
pub fn statusline_color(color: bool, no_color: bool, is_tty: bool, no_color_env: bool) -> bool {
    if no_color || no_color_env {
        return false;
    }
    color || is_tty
}

/// The launcher's fast path for `relay statusline` (`args` after the command name): when every
/// argument is `--color` or `--no-color` and Relay.app has written a snapshot, the line is
/// printed and the exit code returned. `None` hands the run to the full CLI, which explains a
/// missing snapshot in the user's language.
pub fn fast_path(args: &[std::ffi::OsString]) -> Option<i32> {
    if !args.iter().all(|a| a == "--color" || a == "--no-color") {
        return None;
    }
    let env = |name: &str| std::env::var_os(name);
    let home = relay_core::relay_paths::home_dir();
    let snapshot = read_statusline_snapshot(&env, &home, Platform::current())?;
    let stdin = read_stdin(Duration::from_millis(STDIN_WAIT_MS));
    let config_dir = std::env::var("CLAUDE_CONFIG_DIR").ok();
    let no_color_env = std::env::var_os("NO_COLOR").is_some_and(|v| !v.is_empty());
    let line = statusline_text(
        &snapshot,
        &StatuslineRun {
            stdin: &stdin,
            config_dir: config_dir.as_deref(),
            home,
            now: relay_core::clock::now_ms(),
            color: statusline_color(
                args.iter().any(|a| a == "--color"),
                args.iter().any(|a| a == "--no-color"),
                std::io::stdout().is_terminal(),
                no_color_env,
            ),
        },
    );
    if !line.is_empty() {
        use std::io::Write;
        let mut out = std::io::stdout().lock();
        let _ = out.write_all(format!("{line}\n").as_bytes());
        let _ = out.flush();
    }
    Some(0)
}
