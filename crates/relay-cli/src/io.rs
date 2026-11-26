//! Port of `cli/src/io.ts`: everything the CLI reads from and writes to its terminal; tests pass
//! an in-memory one.

use std::collections::BTreeMap;
use std::fmt;
use std::path::PathBuf;
use std::sync::Arc;

/// The signals a running command may take over (`SIGINT`, `SIGTERM`, `SIGHUP`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Signal {
    Int,
    Term,
    Hup,
}

impl Signal {
    /// The POSIX number, for `128 + n` exit codes and passing the signal on.
    pub const fn number(self) -> i32 {
        match self {
            Signal::Hup => 1,
            Signal::Int => 2,
            Signal::Term => 15,
        }
    }
}

pub type SignalHandler = Arc<dyn Fn(Signal) + Send + Sync>;
type Line = Arc<dyn Fn(&str) + Send + Sync>;
/// Asks a question; `None` on end of input or Ctrl+C.
pub type Prompt = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

/// The process environment as the CLI sees it (`NodeJS.ProcessEnv`).
pub type Env = BTreeMap<String, String>;

/// `CliIO`.
#[derive(Clone)]
pub struct CliIo {
    /// Writes one line to stdout.
    pub stdout: Line,
    /// Writes one line to stderr.
    pub stderr: Line,
    /// Both stdin and stdout are a terminal: prompts and colors are allowed.
    pub is_tty: bool,
    /// Asks a question on the terminal; `None` on end of input or Ctrl+C.
    pub prompt: Prompt,
    /// Everything piped to stdin (Claude Code's status line JSON); empty from a terminal.
    pub read_input: Option<Arc<dyn Fn() -> String + Send + Sync>>,
    pub env: Env,
    pub cwd: PathBuf,
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
    pub pid: u32,
    /// While set, SIGINT, SIGTERM and SIGHUP go to the handler instead of ending the process;
    /// `None` gives them back their default.
    pub on_signal: Arc<dyn Fn(Option<SignalHandler>) + Send + Sync>,
}

impl CliIo {
    pub fn out(&self, line: &str) {
        (self.stdout)(line)
    }
    pub fn err(&self, line: &str) {
        (self.stderr)(line)
    }
    pub fn now(&self) -> i64 {
        (self.now)()
    }
    /// `env[name]`, with an empty value as it is (`""`).
    pub fn var(&self, name: &str) -> Option<&str> {
        env_get(&self.env, name)
    }
    /// `!!env[name]`: set and not empty.
    pub fn var_set(&self, name: &str) -> bool {
        self.var(name).is_some_and(|v| !v.is_empty())
    }
    pub fn signal(&self, handler: Option<SignalHandler>) {
        (self.on_signal)(handler)
    }
}

/// `env[name]`; Windows names compare without case, as `process.env` there.
pub fn env_get<'a>(env: &'a Env, name: &str) -> Option<&'a str> {
    if cfg!(windows) {
        env.iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    } else {
        env.get(name).map(String::as_str)
    }
}

pub mod exit {
    pub const OK: i32 = 0;
    pub const FAILED: i32 = 1;
    pub const USAGE: i32 = 2;
    pub const BUSY: i32 = 3;
    pub const CONFIRM: i32 = 4;
    pub const ENVIRONMENT: i32 = 5;
}

/// An error the CLI reports as it is, with its exit code.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CliError {
    pub message: String,
    pub code: i32,
}

impl CliError {
    pub fn new(message: impl Into<String>, code: i32) -> CliError {
        CliError {
            message: message.into(),
            code,
        }
    }
}

impl fmt::Display for CliError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CliError {}
