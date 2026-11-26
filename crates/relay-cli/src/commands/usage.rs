use std::sync::Arc;

use relay_core::profile_lock::profile_lock_holders;
use relay_core::provider_credentials::{CodexReadOptions, read_codex_credential};
use relay_core::provider_usage::{ProviderUsageResult, read_codex_usage};
use relay_core::shared::percent::{format_used, percent_used};
use relay_core::shared::types::{
    Account, AccountProvider, AccountUsage, UsageIssue, UsageStatus, UsageWindow,
};
use relay_core::usage_credentials::UsageError;
use relay_i18n::Args;
use serde_json::{Map, Value, json};

use crate::CommandRun;
use crate::accounts::resolve_account;
use crate::context::{CliContext, Needs, open_context};
use crate::errors::{CliResult, Failure};
use crate::i18n::T;
use crate::io::exit;
use crate::output::{print_json, table};
use crate::time::until_text;
use crate::usage_reader::usage_manager;

/// Where a Codex or Antigravity account is signed in again: the app; `relay connect` is Claude's.
fn in_app(t: T) -> String {
    t.t("commandsUsage.signInAgainInTheRelay")
}

fn provider_of(account: &Account) -> AccountProvider {
    account.provider.unwrap_or(AccountProvider::Claude)
}

fn issue_text(ctx: &CliContext, account: &Account, issue: Option<UsageIssue>) -> String {
    let t = ctx.t;
    let provider = provider_of(account);
    if provider == AccountProvider::Antigravity
        && matches!(issue, Some(UsageIssue::Unsupported) | None)
    {
        return t.t("commandsUsage.antigravityLimitsAreReadInThe");
    }
    if provider == AccountProvider::Codex && issue == Some(UsageIssue::Unsupported) {
        return t.t("commandsUsage.codexReportsNoPlanLimitsFor");
    }
    if provider != AccountProvider::Claude
        && matches!(
            issue,
            Some(
                UsageIssue::CredentialsMissing
                    | UsageIssue::ConnectCli
                    | UsageIssue::Expired
                    | UsageIssue::RenewalRequired
                    | UsageIssue::Scope
                    | UsageIssue::IdentityMismatch
            )
        )
    {
        return t.f(
            "commandsUsage.theSignInCannotBeUsed",
            Args::new().set("inApp", in_app(t)),
        );
    }
    let reconnect = format!("relay connect \"{}\"", account.name);
    let with = |id: &str| t.f(id, Args::new().set("reconnect", reconnect.as_str()));
    match issue {
        Some(UsageIssue::Unavailable) => {
            let renewing =
                profile_lock_holders(&ctx.paths.locks, &account.id, Some(i64::from(ctx.io.pid)))
                    .map(|h| !h.is_empty())
                    .unwrap_or(false);
            t.t(if renewing {
                "commandsUsage.anotherProcessIsRenewingIt"
            } else {
                "commandsUsage.needsTheClaudeCodeCli2"
            })
        }
        Some(UsageIssue::CredentialsMissing | UsageIssue::ConnectCli) => {
            with("commandsUsage.noUsageSignIn")
        }
        Some(UsageIssue::Expired | UsageIssue::RenewalRequired | UsageIssue::Scope) => {
            with("commandsUsage.theConnectionNeedsRenewing")
        }
        Some(UsageIssue::IdentityMismatch) => with("commandsUsage.connectedToAnotherAccount"),
        Some(UsageIssue::KeychainLocked) => t.t("commandsUsage.theKeychainIsLockedUnlockThe"),
        Some(UsageIssue::RateLimited) => t.t("commandsUsage.tooManyRequestsTryAgainShortly"),
        _ => t.t("commandsUsage.couldNotBeRead"),
    }
}

fn window(used: f64, resets_at: Option<&str>) -> Map<String, Value> {
    let mut out = Map::new();
    if let Some(p) = percent_used(Some(used)) {
        out.insert(
            "usedPercent".into(),
            relay_core::store::schema::js_number(p),
        );
    }
    if let Some(at) = resets_at.filter(|r| !r.is_empty()) {
        out.insert("resetsAt".into(), json!(at));
    }
    out
}

fn window_of(w: &UsageWindow) -> Map<String, Value> {
    window(w.used_percent, w.resets_at.as_deref())
}

pub fn usage(run: &CommandRun<'_>) -> CliResult<i32> {
    let (io, t, lang) = (run.io, run.t, run.lang);
    let ctx = open_context(io, run.deps, &run.parsed.flags, Needs::READ)?;
    let all = ctx.store.state().accounts;
    let accounts: Vec<Account> = match run.parsed.positionals.first() {
        Some(query) if !query.is_empty() => vec![resolve_account(&all, query, t)?.clone()],
        _ => all.clone(),
    };
    let store = ctx.store.clone();
    let now = io.now.clone();
    let fetch = ctx.deps.fetch.clone();
    // Codex as the app reads it, through its ChatGPT sign-in. The plan it reports is left for
    // the app to save. Antigravity needs the app's CLIProxyAPI sidecar, which relay never starts.
    let provider = Arc::new(
        move |account: &Account| -> Result<ProviderUsageResult, UsageError> {
            if account.provider == Some(AccountProvider::Codex) {
                let profile = store.profile(&account.id).unwrap_or_default();
                let options = CodexReadOptions {
                    now: Some(now() as f64),
                    cli_files: None,
                };
                let credential = read_codex_credential(&profile, &options);
                let result = read_codex_usage(credential.as_ref(), Some(&fetch), None)?;
                return Ok(ProviderUsageResult {
                    limits: result.limits,
                    plan: None,
                });
            }
            let name = account.provider.map_or("undefined", |p| p.as_str());
            Err(UsageError::with_detail(
                UsageIssue::Unsupported,
                format!("{name}: read in the app"),
            ))
        },
    );
    let manager = usage_manager(&ctx, Some(provider));
    let mut results: Vec<(Account, Option<AccountUsage>)> = Vec::new();
    for account in accounts.iter() {
        let reading = if account.auth.as_ref().is_some_and(|a| a.logged_in) {
            Some(
                manager
                    .refresh(&account.id, io.is_tty)
                    .map_err(|e| Failure::Other(e.to_string()))?,
            )
        } else {
            None
        };
        results.push((account.clone(), reading));
    }
    if ctx.json {
        let items: Vec<Value> = results
            .iter()
            .map(|(account, usage)| {
                let mut item = Map::new();
                item.insert("id".into(), json!(account.id));
                item.insert("name".into(), json!(account.name));
                match usage {
                    None => {
                        item.insert("status".into(), json!("not-connected"));
                    }
                    Some(usage) if usage.status == UsageStatus::Ready => {
                        item.insert("status".into(), json!("ready"));
                        if let Some(w) = &usage.five_hour {
                            item.insert("fiveHour".into(), Value::Object(window_of(w)));
                        }
                        item.insert(
                            "sevenDay".into(),
                            usage
                                .seven_day
                                .as_ref()
                                .map_or(json!("not-reported"), |w| Value::Object(window_of(w))),
                        );
                        if let Some(models) = usage.model_windows.as_ref().filter(|m| !m.is_empty())
                        {
                            let list: Vec<Value> = models
                                .iter()
                                .map(|w| {
                                    let mut m = Map::new();
                                    m.insert("key".into(), json!(w.key));
                                    m.insert("label".into(), json!(w.label));
                                    m.extend(window(w.used_percent, w.resets_at.as_deref()));
                                    Value::Object(m)
                                })
                                .collect();
                            item.insert("models".into(), Value::Array(list));
                        }
                    }
                    Some(usage) => {
                        item.insert("status".into(), json!("error"));
                        if let Some(issue) = usage.issue {
                            item.insert("issue".into(), json!(issue.as_str()));
                        }
                    }
                }
                Value::Object(item)
            })
            .collect();
        print_json(io, &Value::Array(items));
        return Ok(exit::OK);
    }
    if accounts.is_empty() {
        io.out(&t.t("commandsUsage.noAccountsAreSavedYet"));
        return Ok(exit::OK);
    }
    let cell = |w: Option<&UsageWindow>, none: String| match w {
        None => none,
        Some(w) => format!(
            "{}{}",
            format_used(Some(w.used_percent), lang),
            match w.resets_at.as_deref().filter(|r| !r.is_empty()) {
                Some(at) => format!(
                    " · {}",
                    t.f(
                        "commandsUsage.resetsIn",
                        Args::new().set("untilText", until_text(at, io.now(), t))
                    )
                ),
                None => String::new(),
            }
        ),
    };
    let rows: Vec<Vec<String>> = results
        .iter()
        .map(|(account, usage)| match usage {
            None => vec![
                account.name.clone(),
                if provider_of(account) == AccountProvider::Claude {
                    t.f(
                        "commandsUsage.noUsageSignInRelayConnect",
                        Args::new().set("accountName", account.name.as_str()),
                    )
                } else {
                    t.f(
                        "commandsUsage.notSignedIn",
                        Args::new().set("inApp", in_app(t)),
                    )
                },
                String::new(),
            ],
            Some(usage) if usage.status != UsageStatus::Ready => {
                vec![
                    account.name.clone(),
                    issue_text(&ctx, account, usage.issue),
                    String::new(),
                    String::new(),
                ]
            }
            Some(usage) => {
                let models = usage
                    .model_windows
                    .as_deref()
                    .unwrap_or_default()
                    .iter()
                    .map(|w| format!("{} {}", w.label, format_used(Some(w.used_percent), lang)))
                    .collect::<Vec<_>>()
                    .join(", ");
                vec![
                    account.name.clone(),
                    cell(usage.five_hour.as_ref(), "—".into()),
                    cell(
                        usage.seven_day.as_ref(),
                        t.t("commandsUsage.noLimitReported"),
                    ),
                    // A model's own weekly limit (Fable, Opus): spent, it stops that model on the account.
                    if models.is_empty() {
                        "—".into()
                    } else {
                        models
                    },
                ]
            }
        })
        .collect();
    let headers = [
        t.t("common.account"),
        t.t("common.n5Hours"),
        t.t("commandsUsage.weekly"),
        t.t("commandsUsage.modelLimits"),
    ];
    io.out(&table(&headers, &rows));
    Ok(exit::OK)
}
