//! Every command by name, aliases included (`cli/src/commands/index.ts`).

mod add;
mod connect;
mod doctor;
mod history;
mod list;
mod proxy;
mod recover;
mod remove;
mod rename;
mod reset_vault;
mod run;
mod status;
mod statusline;
mod switch;
mod tokens;
mod usage;

pub use proxy::parse_upstreams;

use crate::CommandRun;
use crate::errors::CliResult;

pub type Command = fn(&CommandRun<'_>) -> CliResult<i32>;

pub fn command(name: &str) -> Option<Command> {
    Some(match name {
        "status" => status::status,
        "list" | "ls" => list::list,
        "switch" => switch::switch_command,
        "recover" => recover::recover,
        "add" => add::add,
        "remove" => remove::remove,
        "rename" => rename::rename,
        "history" => history::history,
        "connect" => connect::connect,
        "usage" => usage::usage,
        "run" => run::run,
        "tokens" => tokens::tokens,
        "doctor" => doctor::doctor,
        "proxy" => proxy::proxy_command,
        "statusline" => statusline::statusline_command,
        "reset-vault" => reset_vault::reset_vault,
        _ => return None,
    })
}
