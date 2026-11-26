//! Port of `cli/src/process-io.ts` and the signal wiring of `cli/src/bin.ts`: the terminal as a
//! `CliIo`. A write to a terminal that hung up (EIO) or a closed pipe (EPIPE) is dropped instead
//! of ending the process: a Desktop operation that is swapping files must be able to finish
//! after its window closed.

use std::io::{BufRead, IsTerminal, Write};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::io::{CliIo, Env, Signal, SignalHandler};
use crate::statusline::{STDIN_WAIT_MS, read_stdin};

/// Where SIGINT, SIGTERM and SIGHUP go while a command holds them.
static HANDLER: Mutex<Option<SignalHandler>> = Mutex::new(None);

fn handler() -> Option<SignalHandler> {
    HANDLER.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

fn set_handler(next: Option<SignalHandler>) -> Option<SignalHandler> {
    std::mem::replace(
        &mut *HANDLER.lock().unwrap_or_else(|e| e.into_inner()),
        next,
    )
}

/// A signal arrived: to the command's handler, else the process ends with 128 + its number.
fn deliver(signal: Signal) {
    match handler() {
        Some(handler) => handler(signal),
        None => std::process::exit(128 + signal.number()),
    }
}

/// Starts delivering this process's SIGINT, SIGTERM and SIGHUP (Ctrl+C, Ctrl+Break and a closed
/// console on Windows) through [`deliver`].
pub fn install_signals() {
    #[cfg(unix)]
    {
        use signal_hook::consts::{SIGHUP, SIGINT, SIGTERM};
        if let Ok(mut signals) = signal_hook::iterator::Signals::new([SIGINT, SIGTERM, SIGHUP]) {
            let _ = std::thread::Builder::new()
                .name("relay-signals".into())
                .spawn(move || {
                    for number in signals.forever() {
                        deliver(match number {
                            SIGTERM => Signal::Term,
                            SIGHUP => Signal::Hup,
                            _ => Signal::Int,
                        });
                    }
                });
        }
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{FALSE, TRUE};
        use windows_sys::Win32::System::Console::{
            CTRL_BREAK_EVENT, CTRL_C_EVENT, CTRL_CLOSE_EVENT, SetConsoleCtrlHandler,
        };
        unsafe extern "system" fn on_ctrl(kind: u32) -> windows_sys::core::BOOL {
            let signal = match kind {
                CTRL_C_EVENT | CTRL_BREAK_EVENT => Signal::Int,
                CTRL_CLOSE_EVENT => Signal::Hup,
                _ => return FALSE,
            };
            deliver(signal);
            TRUE
        }
        // SAFETY: registers a handler with the signature the console API calls.
        unsafe {
            SetConsoleCtrlHandler(Some(on_ctrl), TRUE);
        }
    }
}

fn write_line(stream: &mut dyn Write, line: &str) {
    // Nobody is reading any more: dropped.
    let _ = stream.write_all(format!("{line}\n").as_bytes());
    let _ = stream.flush();
}

/// Asks `question` on the terminal: the answer line, or `None` at end of input or on Ctrl+C
/// (which also ends the line on screen).
fn prompt(question: &str) -> Option<String> {
    {
        let mut out = std::io::stdout().lock();
        let _ = out.write_all(question.as_bytes());
        let _ = out.flush();
    }
    let (send, answer) = mpsc::channel::<Option<String>>();
    let interrupt = send.clone();
    let previous = set_handler(Some(Arc::new(move |signal| {
        if signal == Signal::Int {
            let _ = interrupt.send(None);
        } else {
            std::process::exit(128 + signal.number());
        }
    })));
    let _ = std::thread::Builder::new().spawn(move || {
        let mut line = String::new();
        let read = std::io::stdin().lock().read_line(&mut line);
        let _ = send.send(match read {
            Ok(0) | Err(_) => None,
            Ok(_) => Some(line.trim_end_matches(['\n', '\r']).to_owned()),
        });
    });
    let result = answer.recv().unwrap_or(None);
    set_handler(previous);
    result
}

/// This process's environment as text; names or values that are not Unicode are left out.
pub fn process_env() -> Env {
    std::env::vars_os()
        .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
        .collect()
}

/// The terminal this process runs in.
pub fn process_io() -> CliIo {
    let is_tty = std::io::stdin().is_terminal() && std::io::stdout().is_terminal();
    CliIo {
        stdout: Arc::new(|line| write_line(&mut std::io::stdout().lock(), line)),
        stderr: Arc::new(|line| write_line(&mut std::io::stderr().lock(), line)),
        is_tty,
        prompt: Arc::new(|question| {
            let answer = prompt(question);
            if answer.is_none() {
                write_line(&mut std::io::stdout().lock(), "");
            }
            answer
        }),
        read_input: Some(Arc::new(|| {
            read_stdin(Duration::from_millis(STDIN_WAIT_MS))
        })),
        env: process_env(),
        cwd: std::env::current_dir().unwrap_or_default(),
        now: Arc::new(relay_core::clock::now_ms),
        pid: std::process::id(),
        on_signal: Arc::new(|next| {
            set_handler(next);
        }),
    }
}
