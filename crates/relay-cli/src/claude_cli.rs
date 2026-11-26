//! Port of `cli/src/claude-cli.ts`.

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::environment::cli_environment;
use crate::io::Env;

/// An exit status as Node reports it: the code, or 128 + the signal number.
pub fn exit_code(status: std::process::ExitStatus) -> i32 {
    if let Some(code) = status.code() {
        return code;
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return 128 + signal;
        }
    }
    129
}

/// Runs the official Claude Code CLI in an account's isolated profile and returns its exit code
/// (or 128 + the signal number). `inherit` gives it this terminal; otherwise its output is
/// discarded, so nothing it prints (a token included) reaches Relay's output.
pub fn run_claude(
    executable: &str,
    args: &[&str],
    profile: &Path,
    env: &Env,
    inherit: bool,
    timeout: Option<Duration>,
) -> std::io::Result<i32> {
    let profile_text = profile.to_string_lossy();
    let mut command = Command::new(executable);
    command
        .args(args)
        .current_dir(profile)
        .env_clear()
        .envs(cli_environment(&profile_text, env));
    if !inherit {
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
    }
    let mut child = command.spawn()?;
    let Some(timeout) = timeout else {
        return child.wait().map(exit_code);
    };
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(exit_code(status));
        }
        if Instant::now() >= deadline {
            // SIGKILL, as the TS timer sends.
            let _ = child.kill();
            return child.wait().map(exit_code);
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}
