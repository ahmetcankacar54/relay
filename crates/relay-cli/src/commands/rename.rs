use relay_i18n::Args;

use crate::CommandRun;
use crate::accounts::{assert_free_name, resolve_account};
use crate::context::{Needs, open_context};
use crate::errors::CliResult;
use crate::io::{CliError, exit};
use crate::output::js_len;

pub fn rename(run: &CommandRun<'_>) -> CliResult<i32> {
    let (io, t, p) = (run.io, run.t, &run.parsed.positionals);
    let query = p.first().filter(|q| !q.is_empty());
    let name = p
        .get(1)
        .map(|n| relay_core::store::schema::js_trim(n).to_owned());
    let (Some(query), Some(name)) = (query, name.filter(|n| !n.is_empty())) else {
        return Err(CliError::new(t.t("rename.usageRelayRenameNameNewName"), exit::USAGE).into());
    };
    if p.len() > 2 || js_len(&name) > 64 {
        return Err(CliError::new(t.t("rename.usageRelayRenameNameNewName"), exit::USAGE).into());
    }
    let ctx = open_context(io, run.deps, &run.parsed.flags, Needs::WRITE)?;
    let accounts = ctx.store.state().accounts;
    let account = resolve_account(&accounts, query, t)?;
    assert_free_name(&accounts, &name, t, Some(&account.id))?;
    let id = account.id.clone();
    ctx.store.update(|s| {
        if let Some(a) = s.accounts.iter_mut().find(|a| a.id == id) {
            a.name = name.clone();
        }
    })?;
    io.out(
        &t.f(
            "rename.msg",
            Args::new()
                .set("accountName", account.name.as_str())
                .set("name", name.as_str()),
        ),
    );
    Ok(exit::OK)
}
