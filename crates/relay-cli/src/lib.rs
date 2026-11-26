//! `relay`: switch the Claude desktop app between saved accounts from the terminal. A port of
//! `cli/src/**`; `run_cli` is `runCli` (cli/src/main.ts) with an injectable terminal and deps.

pub mod accounts;
pub mod args;
pub mod claude_cli;
pub mod commands;
pub mod confirm;
pub mod context;
pub mod deps;
pub mod describe;
pub mod desktop_op;
pub mod environment;
pub mod errors;
pub mod guards;
pub mod help;
pub mod host;
pub mod i18n;
pub mod inside_desktop;
pub mod io;
pub mod json;
pub mod output;
pub mod process_io;
pub mod risk;
pub mod shield;
pub mod statusline;
pub mod time;
pub mod usage_reader;
pub mod util;

use relay_i18n::Locale;

use crate::args::{ParsedCommand, parse_command};
use crate::context::cli_paths;
use crate::deps::CliDeps;
use crate::errors::{CliResult, Failure, describe_error};
use crate::help::help_text;
use crate::i18n::{T, pick_lang};
use crate::io::{CliError, CliIo, exit};

/// The CLI's own version; tests keep it equal to cli/package.json's.
pub const CLI_VERSION: &str = "0.2.0";

/// What a command is called with; it opens its own context with the needs it has.
pub struct CommandRun<'a> {
    pub io: &'a CliIo,
    pub deps: &'a CliDeps,
    pub parsed: &'a ParsedCommand,
    pub t: T,
    pub lang: Locale,
    /// The arguments as given, for a command handed to a worker.
    pub argv: &'a [String],
}

fn dispatch(argv: &[String], io: &CliIo, deps: &CliDeps, lang: &mut Locale) -> CliResult<i32> {
    let parsed = parse_command(argv)?;
    *lang = pick_lang(parsed.flags.str("lang"), &io.env);
    let t = T(*lang);
    if parsed.flags.truthy("version") {
        io.out(CLI_VERSION);
        return Ok(exit::OK);
    }
    let command = parsed.command.as_deref();
    if command.is_none() || command == Some("help") || parsed.flags.truthy("help") {
        io.out(&help_text(t));
        return Ok(exit::OK);
    }
    if command == Some("__worker") {
        let dir = cli_paths(&io.env).cli_operations;
        let id = parsed.positionals.first().map_or("", String::as_str);
        return inside_desktop::run_worker(&dir, id, io, &|args, worker_io| {
            run_cli(args, worker_io, deps)
        });
    }
    let Some(run) = commands::command(command.unwrap_or_default()) else {
        return Err(Failure::Cli(CliError::new(
            t.f(
                "srcMain.unknownCommandForTheCommandsRelay",
                relay_i18n::Args::new().set("parsedCommand", command.unwrap_or_default()),
            ),
            exit::USAGE,
        )));
    };
    run(&CommandRun {
        io,
        deps,
        parsed: &parsed,
        t,
        lang: *lang,
        argv,
    })
}

/// Runs one `relay` invocation and returns its exit code. Never panics on a command's failure.
pub fn run_cli(argv: &[String], io: &CliIo, deps: &CliDeps) -> i32 {
    let mut lang = pick_lang(None, &io.env);
    match dispatch(argv, io, deps, &mut lang) {
        Ok(code) => code,
        Err(error) => {
            let (message, code) = describe_error(&error, lang, io.now());
            io.err(&format!("relay: {message}"));
            code
        }
    }
}
