use serde_json::{Map, Value, json};

use crate::CommandRun;
use crate::context::{Needs, open_context};
use crate::describe::{kind_text, limits_state, limits_text};
use crate::errors::CliResult;
use crate::output::{Style, paint, print_json, table};

pub fn list(run: &CommandRun<'_>) -> CliResult<i32> {
    let (io, t) = (run.io, run.t);
    let ctx = open_context(io, run.deps, &run.parsed.flags, Needs::READ)?;
    let state = ctx.desktop.snapshot().map_err(|e| ctx.desktop_failure(e))?;
    let accounts = ctx.store.state().accounts;
    let active = |id: &str| state.active_profile_id.as_deref() == Some(id);
    if ctx.json {
        let items: Vec<Value> = accounts
            .iter()
            .map(|a| {
                let mut desktop = Map::new();
                desktop.insert("linked".into(), json!(a.desktop.is_some()));
                if let Some(email) = a
                    .desktop
                    .as_ref()
                    .and_then(|d| d.email.as_deref())
                    .filter(|e| !e.is_empty())
                {
                    desktop.insert("email".into(), json!(email));
                }
                json!({
                    "id": a.id,
                    "name": a.name,
                    "kind": a.kind.as_str(),
                    "group": a.group,
                    "active": active(&a.id),
                    "desktop": desktop,
                    "limits": limits_state(a).as_str(),
                })
            })
            .collect();
        print_json(io, &Value::Array(items));
        return Ok(0);
    }
    if accounts.is_empty() {
        io.out(&t.t("list.noAccountsAreSavedYetTo"));
        return Ok(0);
    }
    let rows: Vec<Vec<String>> = accounts
        .iter()
        .map(|a| {
            let is_active = active(&a.id);
            let provider = a.provider.map_or("claude", |p| p.as_str()).to_uppercase();
            vec![
                if is_active { "*" } else { " " }.to_owned(),
                if is_active {
                    paint(ctx.color, Style::Bold, &a.name)
                } else {
                    a.name.clone()
                },
                provider,
                kind_text(a, t),
                match &a.desktop {
                    Some(d) => d.email.clone().unwrap_or_else(|| t.t("list.saved")),
                    None => t.t("list.msg"),
                },
                limits_text(limits_state(a), t),
            ]
        })
        .collect();
    let headers = [
        String::new(),
        t.t("list.name"),
        t.t("common.provider"),
        t.t("list.kind"),
        t.t("common.claudeApp"),
        t.t("list.usageSignIn"),
    ];
    io.out(&table(&headers, &rows));
    Ok(0)
}
